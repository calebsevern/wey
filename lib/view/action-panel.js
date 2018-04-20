const gui = require('gui')
const slackTheme = require('./theme/slack/global')

const CHANNEL_TITLE_FONT = gui.Font.default().derive(4, 'bold', 'normal')
const CHANNEL_TITLE_PADDING = 20

class ActionPanel {
  constructor(mainWindow) {
    this.mainWindow = mainWindow

    this.channel = null
    this.channelTitle = ''

    this.view = gui.Container.create()
    this.view.setStyle({height: '72px'})
    this.view.setBackgroundColor('#FFFFFF')
    this.view.onDraw = this.draw.bind(this)
  }

  unload() {
    if (this.channel)
      this.channel = null
  }

  async loadChannel(account, channel) {
    this.channel = channel
    if (channel.type === 'channel')
      this.channelTitle = (channel.isPrivate ? 'θ' : '#') + ' ' + channel.name
    else
      this.channelTitle = channel.name

    this.update()
  }

  update() {
    this.view.schedulePaint()
  }

  draw(view, painter, dirty) {
    const bounds = view.getBounds()
    if (this.channel)
      this.drawChannelTitle(painter, bounds)
    this.drawBottomBorder(painter, bounds)
  }

  drawChannelTitle(painter, bounds) {
    const attributes = {
      color: slackTheme.PRIMARY_FONT_COLOR,
      font: CHANNEL_TITLE_FONT,
    }
    const textRect = {
      x: CHANNEL_TITLE_PADDING,
      y: CHANNEL_TITLE_PADDING,
      width: bounds.width,
      height: bounds.height,
    }
    painter.drawText(this.channelTitle, textRect, attributes)
  }

  drawBottomBorder(painter, bounds) {
    painter.setStrokeColor(slackTheme.LIGHT_BORDER_COLOR)
    painter.beginPath()
    painter.setLineWidth(2)
    painter.moveTo({x: 0, y: bounds.height})
    painter.lineTo({x: bounds.width, y: bounds.height})
    painter.stroke()
  }
}

module.exports = ActionPanel
