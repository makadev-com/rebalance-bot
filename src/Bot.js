const configs = require('../configs')
const { Exchange } = require('./exchange')
const { logger } = require('./logger')
const { sleep } = require('./utils')
const { getDb } = require('./db')

class Bot {

    constructor(config, exchange) {

        this.config = config

        const pair = config.symbol.split('/')

        this.baseCurrency = pair[0]
        this.quoteCurrency = pair[1]


        this.ex = exchange

        this.setupDb(getDb(this.config.id))
        logger.info(`Bot instantiated - Trading ${config.symbol} on ${config.exchangeId} `)

    }

    setupDb(db) {
        this.db = db
        this.collections = {
            stick: 'stick',
            lastFilledOrderPrice: 'lastFilledOrderPrice'
        }

        // Set some defaults (required if your JSON file is empty)
        this.db.defaults({
            stick: {
                amount: null,
                actualAmount: null,
                price: null,
                orderId: null,
                orderSide: null,
                orderStatus: null,
            },
            lastFilledOrderPrice: 0
        })
            .write()

    }

    async buy(amount, price) {
        price = await this.ex.decimalToPrecision(
            price, //* (1 + this.config.pricePercentageGap),
            'price'
        )

        let order = await this.ex.createOrder('buy', amount, price)

        // let order = {
        //     "info": { "status": "ok", "data": "201305364749182" },
        //     "id": "201305364749182",
        //     "timestamp": 1612077721476,
        //     "datetime": "2021-01-31T07:22:01.476Z",
        //     "symbol": "ETH/USDT",
        //     "type": "limit",
        //     "side": "buy",
        //     "price": 1354.34,
        //     "amount": 0.0448
        // }


        if (order.status === 'canceled' && order.postOnly) {
            logger.info(`Buy canceled (Taker) - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)
            await this.buy(amount, price - (price * this.config.postOnlyTickPercentage / 100))
        } else {
            logger.info(`Buy - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)
            this.updateStick(order)
        }

    }

    async sell(amount, price) {
        price = await this.ex.decimalToPrecision(
            price, //price - (price * this.config.pricePercentageGap),
            'price'
        )

        let order = await this.ex.createOrder('sell', amount, price)


        if (order.status === 'canceled' && order.postOnly) {
            logger.info(`Sell canceled (Taker)  - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)

            await this.sell(amount, price + (price * this.config.postOnlyTickPercentage / 100))
        } else {
            logger.info(`Sell   - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)
            this.updateStick(order)

        }

    }


    updateStick(order) {

        if (order.status === 'closed') {
            this.db.set(this.collections.lastFilledOrderPrice, order.price).write()
            this.db.get(this.collections.stick).assign({
                amount: null,
                actualAmount: null,
                price: null,
                orderId: null,
                orderSide: null,
                orderStatus: null
            }).write()
        } else {
            this.db.get(this.collections.stick).assign({
                amount: order.amount,
                actualAmount: order.side === 'buy' && order.fee && order.fee.cost
                    ? order.amount - order.fee.cost
                    : order.amount,
                price: order.price,
                orderId: order.id,
                orderSide: order.side,
                orderStatus: order.status,
            }).write()

        }

    }

    async cancel(stick) {
        await this.ex.cancelOrder(stick.orderId)
        this.prepareSticks()
    }

    async clearStaleSticks() {

        const stick = this.db.get(this.collections.stick).value()

        if (stick.orderStatus === 'open') {

            const order = await this.ex.fetchOrder(stick.orderId)

            // TODO check if is partial filled then set it as last price

            if (order.status === 'open') {
                if (order.filled !== 0 && order.filled < order.amount) {
                    this.db.set(this.collections.lastFilledOrderPrice, order.price).write()
                    this.lastFilledOrderPrice = order.price
                }
            } else if (order.status === 'closed') {

                this.updateStick(order)

            } else if (order.status === 'canceled') {
                this.db.get(this.collections.stick).assign({
                    amount: null,
                    actualAmount: null,
                    price: null,
                    orderId: null,
                    orderSide: null,
                    orderStatus: null
                }).write()

            }
        }

    }


    prepareSticks() {
        // Prepare sticks

        this.stick = this.db.get(this.collections.stick).value()
        this.lastFilledOrderPrice = this.db.get(this.collections.lastFilledOrderPrice).value()

        logger.debug(`this.stick ${JSON.stringify(this.stick, null, 4)}`)
    }


    async run() {


        await this.clearStaleSticks()
        this.prepareSticks()


        const {
            minDiffValue,
            minDiffType,
        } = this.config

        const balance = await this.ex.fetchBalance()
        const price = await this.ex.getLastPrice()

        const totalBaseCurrency = balance.total[this.baseCurrency]
        const totalQuoteCurrency = balance.total[this.quoteCurrency]

        let shouldExecute = false

        const priceDiff = Math.abs(this.lastFilledOrderPrice - price)

        logger.info(`price - ${price}`)
        logger.info(`totalBaseCurrency - ${totalBaseCurrency}`)
        logger.info(`totalQuoteCurrency - ${totalQuoteCurrency}`)
        logger.info(`priceDiff - ${priceDiff}`)
        logger.info(`minDiffValue - ${minDiffValue}`)

        if (minDiffType === 'FIXED') {

            shouldExecute = priceDiff >= minDiffValue

        } else if (minDiffType === 'PERCENTAGE') {

            const percentageDiff =  priceDiff / this.lastFilledOrderPrice * 100 
            logger.info(`percentageDiff - ${percentageDiff}`)
           
            shouldExecute = percentageDiff > minDiffValue

        }

        logger.info(`shouldExecute - ${shouldExecute}`)

        if (shouldExecute) {

            if (this.stick.orderStatus === 'open') {
                logger.info(`cancelling order - ${JSON.stringify(this.stick, null, 4)}`)

                await this.cancel(this.stick)
            }


            await this.execute({ totalBaseCurrency, totalQuoteCurrency, price })

        }
    }


    async execute({ totalBaseCurrency, totalQuoteCurrency, price }) {
        logger.info(`executing`, JSON.stringify(this.config, null, 4))
        logger.info(`totalBaseCurrency - ${totalBaseCurrency}`)
        logger.info(`totalQuoteCurrency - ${totalQuoteCurrency}`)
        logger.info(`price - ${price}`)

        const {
            conditionValue,
            conditionType
        } = this.config
        const totalBaseInQuoteCurrency = totalBaseCurrency * price

        logger.info(`totalBaseInQuoteCurrency - ${totalBaseInQuoteCurrency}`)

        let side, amount


        if (conditionType === 'FIXED') {

            const valueDiff = totalBaseInQuoteCurrency - conditionValue

            amount = Math.abs(valueDiff) / price

            side = valueDiff > 0 ? 'sell' : 'buy'

        } else if (conditionType === 'PERCENTAGE') {

            const totalBalanceInBaseCurrency = totalBaseInQuoteCurrency + totalBaseCurrency
            const currentPercentage = (totalBaseInQuoteCurrency / totalBalanceInBaseCurrency) * 100

            const diffPercentage = Math.abs(currentPercentage - conditionValue)

            amount = ((diffPercentage / 100) * totalBalanceInBaseCurrency) / price

            side = currentPercentage > conditionValue ? 'sell' : 'buy'

        }

        logger.info(`side - ${side}`)
        logger.info(`amount - ${amount}`)

        price = await this.ex.decimalToPrecision(
            price, //* (1 + this.config.pricePercentageGap),
            'price'
        )

        logger.info(`price - ${price}`)

        const { limits } = await this.ex.getMarket()

        if (amount < limits.amount.min) {

            logger.info(`Halt execution: limits.amount.min - ${limits.amount.min}, amount - ${amount}`)

        } else if (parseFloat(price) < limits.price.min) {

            logger.info(`Halt execution: limits.price.min - ${limits.price.min}, price - ${price}`)

        } else if ((amount * parseFloat(price)) < limits.cost.min) {

            logger.info(`Halt execution: limits.cost.min - ${limits.cost.min}, cost ${amount * parseFloat(price)}`)

        } else {

            let order = await this.ex.createOrder(side, amount, price)

            logger.info(`order - ${JSON.stringify(order, null, 4)}`)

            if (order.status === 'canceled' && order.postOnly) {
                logger.info(`${side} canceled (Taker) - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)

                const orderBook = await this.ex.getOrderBook()
                const key = side === 'buy' ? 'bids' : 'asks'

                await this.execute({ totalBaseCurrency, totalQuoteCurrency, price: orderBook[key][0][0] })
            } else {
                logger.info(`${side} - ${order.amount.toFixed(8)} ${this.baseCurrency} at ${order.price.toFixed(2)} ${this.quoteCurrency} ${order.datetime}`)
                this.updateStick(order)
            }

        }



    }
}






const bootstrap = async () => {

    const args = process.argv
    const botId = args[2]
    const config = configs[botId]

    const { timeSequence, timeSequenceMultiplier } = config

    const ex = new Exchange(config)
    const bot = new Bot(config, ex)

    await sleep(2000)
    await bot.ex.loadMarkets()

    while (true) {
        for (let i of timeSequence) {

            logger.info(`---------------------------`)
            logger.info(`------ New Iteration ------`)
            logger.info(`---------------------------`)

            await bot.run()

            await sleep(i * 1000 * timeSequenceMultiplier)

        }

    }
}


bootstrap()