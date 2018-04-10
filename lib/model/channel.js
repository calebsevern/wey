const Signal = require('mini-signals')

const STOP_RECEIVING_TIMEOUT = 60 * 60 * 1000  // 1 hour
const MARK_TIMEOUT = 5 * 1000  // 5 seconds

const CACHE_MESSAGES_LIMIT = 300

class Channel {
  constructor(account, type, id, name) {
    this.account = account
    this.type = type
    this.id = id
    this.name = name

    this.description = '(No description)'
    this.messages = []
    this.isMember = false
    this.isPrivate = false
    this.isDefault = false
    this.isMultiParty = false
    this.isMuted = false

    // Whether all messages of channel have been read.
    this.isRead = true

    // Timestamp of last read message.
    this.lastReadTs = null

    // Timestamp of first unread message.
    this.firstUnreadTs = null

    // Timestamp of last main message, the |messages| may have sub messages.
    this.latestTs = null

    // Whether channel is being displayed.
    this.isDisplaying = false
    this.viewerCount = 0

    // Whether channel is receiving messages.
    this.isReceiving = false
    this.receiverCount = 0

    // Whether we need to fetch messages before reading.
    this.messagesReady = false

    // A promised indicating the progress of current readMessages, so we won't
    // have race conditions when calling readMessages on parallel.
    this.readMessagesPromise = null

    // Timeout for stop receiving.
    this.stopTimer = null

    // Timeout for sending mark information.
    this.markTimer = null

    this.onMessage = new Signal()
    this.onDeleteMessage = new Signal()
    this.onModifyMessage = new Signal()
    this.onUpdateReadState = new Signal()
  }

  markRead() {
    // Clear the unread marker.
    this.lastReadTs = this.latestTs
    this.firstUnreadTs = null
    // Update account's read state.
    if (this.isRead)
      return
    this.isRead = true
    this.onUpdateReadState.dispatch()
    if (!this.account.isRead)
      this.account.setReadState(this.account.computeReadState())
  }

  markUnread() {
    if (!this.isRead || this.isDisplaying)
      return
    this.isRead = false
    this.onUpdateReadState.dispatch()
    // Update account's read state.
    if (this.account.isRead)
      this.account.setReadState(false)
  }

  select() {
    this.viewerCount++
    this.isDisplaying = true
    if (this.messagesReady)
      this.markRead()
  }

  deselect() {
    if (--this.viewerCount === 0)
      this.isDisplaying = false
  }

  startReceiving() {
    this.receiverCount++
    this.isReceiving = true
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
  }

  stopReceiving() {
    if (--this.receiverCount === 0)
      this.stopTimer = setTimeout(this.stopReceivingImpl.bind(this),
                                  STOP_RECEIVING_TIMEOUT)
  }

  stopReceivingImpl() {
    this.isReceiving = false
    this.stopTimer = null
    this.clear()
  }

  clear() {
    this.messagesReady = false
    this.messages = []
  }

  hasMessages() {
    return this.messages.length > 0
  }

  latestMessage() {
    return this.messages[this.messages.length - 1]
  }

  // Compute day markers and whether messages should be folded.
  foldMessages(messages) {
    for (const i in messages) {
      if (i == 0) {
        messages[i].setDayMarker()
        continue
      }
      this.compareMessage(messages[i], messages[i - 1])
    }
    return messages
  }

  compareMessage(m, pm) {
    if (m.user.id == pm.user.id &&
        m.date.getTime() - pm.date.getTime() < 5 * 60 * 1000)
      m.isFolded = true
    if (m.date.getDate() != pm.date.getDate())
      m.setDayMarker()
    // Find out first unread message.
    if (this.lastReadTs && this.lastReadTs === pm.timestamp)
      this.firstUnreadTs = m.timestamp
  }

  findMessageIndex(id, timestamp) {
    if (!this.hasMessages())
      return -1
    const date = new Date(timestamp * 1000)
    for (let i = this.messages.length - 1; i > 0; --i) {
      const message = this.messages[i]
      if (message.id == id)
        return i
      if (message.date < date)
        return -1
    }
    return -1
  }

  async dispatchMessage(message) {
    // Update latest ts.
    if (!message.isSub &&
        this.latestTs * 1 < message.timestamp * 1)
      this.latestTs = message.timestamp
    // Handled read state.
    if (this.isDisplaying) {
      this.notifyRead()
      this.lastReadTs = this.latestTs
    } else {
      this.markUnread()
      if (!this.firstUnreadTs)
        this.firstUnreadTs = this.latestTs
    }
    // Only store messages when necessary.
    if (!this.isReceiving) {
      // Invalidate the old stored messages.
      this.messagesReady = false
      return
    }
    // If we are in the process of reading messages, wait until it is done.
    if (this.readMessagesPromise) {
      await this.readMessagesPromise
      // Do nothing if our new message is older then received.
      if (this.hasMessages() && message.date <= this.latestMessage().date)
        return
    }
    // Handle thew new message.
    if (this.hasMessages())
      this.compareMessage(message, this.latestMessage())
    this.messages.push(message)
    // Limit the size of cached messages, remove many items to avoid calling
    // splice too often.
    if (this.messages.length > CACHE_MESSAGES_LIMIT) {
      this.messages.splice(0, 50)
      this.messages[0].setDayMarker()
    }
    // Dispatch the message.
    this.onMessage.dispatch(message)
  }

  deleteMessage(id, timestamp) {
    if (!this.isReceiving)
      return
    const i = this.findMessageIndex(id, timestamp)
    if (i !== -1) {
      this.messages.splice(i, 1)
      this.onDeleteMessage.dispatch(id, timestamp)
    }
  }

  modifyMessage(id, timestamp, text) {
    if (!this.isReceiving)
      return
    const i = this.findMessageIndex(id, timestamp)
    if (i !== -1) {
      this.messages[i].text = text
      this.onModifyMessage.dispatch(id, timestamp, text)
    }
  }

  async readMessages() {
    if (this.messagesReady)
      return this.messages
    // Handle parallel reads.
    if (!this.readMessagesPromise)
      this.readMessagesPromise = this.readMessagesImpl()
    const messages = await this.readMessagesPromise
    this.readMessagesPromise = null
    // Concatenate messages.
    this.messages = this.foldMessages(messages).concat(this.messages)
    // Update latestTs.
    if (!this.latestTs && this.hasMessages())
      this.latestTs = this.latestMessage().timestamp
    // Good time to collect garbages
    process.gc()
    // Mark as ready when connected and no error happened, otherwise clear the
    // messages.
    if (this.account.status === 'connected')
      this.messagesReady = true
    else
      this.messages = []
    return this.messages
  }

  async readMessagesImpl() {
    throw new Error('Should be implemented by subclasses')
  }

  async sendMessage(message) {
    throw new Error('Should be implemented by subclasses')
  }

  async notifyRead() {
    this.markRead()
    if (this.messages.length == 0)
      return
    if (this.markTimer)
      clearTimeout(this.markTimer)
    this.markTimer = setTimeout(this.notifyReadImpl.bind(this), MARK_TIMEOUT)
  }

  async notifyReadImpl() {
    throw new Error('Should be implemented by subclasses')
  }
}

module.exports = Channel
