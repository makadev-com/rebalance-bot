const ccxt = require('ccxt')
const { sleep } = require('./utils')
const { logger } = require('./logger')

class Exchange {
    constructor(config) {
        const {
            secret,
            apiKey,
            apiPassphrase,
            password,
            symbol,
            exchangeId,
            timeFrame,
            postOnly
        } = config

        const exchangeClass = ccxt[exchangeId]

        let extraConfig = {}

        if(apiPassphrase || password){
            extraConfig.password =  apiPassphrase || password
        }

        this.ex = new exchangeClass({
            apiKey,
            secret,
            timeout: 30000,
            enabaleRateLimit: true,
            ...extraConfig
        })

        this.postOnly = postOnly
        this.symbol = symbol
        this.timeFrame = timeFrame
    }

    async getBalance() {
        return await this.request(this.ex.fetchBalance)
    }

    async loadMarkets() {
        await this.request(this.ex.loadMarkets)
    }

    async getLastPrice() {
        const ticker = await this.request(this.ex.fetchTicker, [this.symbol])
        return ticker.last
    }

    async getOrderBook(){
        return await this.request(this.ex.fetchOrderBook, [this.symbol])
    }

    async getMarket(){
        const markets = this.ex.markets
        const market = markets[this.symbol]
        return market
    }

    async decimalToPrecision(decimal, precisionType) {

        const market = await this.getMarket()

        // logger.debug(`market: ${JSON.stringify(market)}`)
        // logger.debug(`market.precision[precisionType]: ${JSON.stringify(market.precision[precisionType])}`)
        // logger.debug(`this.ex.precisionMode: ${JSON.stringify(this.ex.precisionMode)}`)

        const precision = ccxt.decimalToPrecision(
            decimal,
            precisionType === 'amount' ? ccxt.TRUNCATE : ccxt.ROUND,
            market.precision[precisionType],
            this.ex.precisionMode
        )
        // logger.debug(`precision: ${JSON.stringify(precision)}`)

        return parseFloat(precision)
    }

    async createOrder(side, amount, price) {
        const params = {postOnly: !!this.postOnly}
        let order = await this.request(this.ex.createOrder, [this.symbol, 'limit', side, amount, price, params])
        order = await this.fetchOrder(order.id)

        // logger.debug(`createOrder: ${JSON.stringify(order)}`)
        return order
    }

    async fetchOrder(id) {
        const order = await this.request(this.ex.fetchOrder, [id, this.symbol])
        // logger.debug(`fetchOrder: ${JSON.stringify(order)}`)
        return order
    }

    async cancelOrder(id){
        logger.debug(`cancel order: ${JSON.stringify(id)}`)
        const order = await this.request(this.ex.cancelOrder, [id])
        logger.debug(`order: ${JSON.stringify(order, null, 4)}`)
    }

    async fetchBalance() {
        const balance = await this.request(this.ex.fetchBalance)
        delete balance.info
        const pairs = this.symbol.split('/')
        const baseCurrency = pairs[0]
        const quoteCurrency = pairs[1]
        return {
            free: {
                [baseCurrency]: balance.free[baseCurrency] || 0,
                [quoteCurrency]: balance.free[quoteCurrency] || 0
            },
            used: {
                [baseCurrency]: balance.used[baseCurrency] || 0,
                [quoteCurrency]: balance.used[quoteCurrency] || 0
            },
            total: {
                [baseCurrency]: balance.total[baseCurrency] || 0,
                [quoteCurrency]: balance.total[quoteCurrency] || 0
            }
        }
    }

    async fetchCandles(timeFrame) {
        const res = await this.request(this.ex.fetchOHLCV, [this.symbol, timeFrame || this.timeFrame, undefined, 200])
        const candles = res.map(ohlcv => ({
            timestamp: ohlcv[0],
            open: ohlcv[1],
            high: ohlcv[2],
            low: ohlcv[3],
            close: ohlcv[4],
            volume: ohlcv[5]
        }))
        // newest candle is last in list
        // console.log(candles[candles.length-1])
        // console.log(candles[candles.length-2])
        // console.log(candles[candles.length-3])

        // Remove current candle
        candles.pop()

        return candles;
    }

    async retry(action, args, limit, attempt) {
        logger.warn(`An exchange error occured, retrying in ${attempt} second(s) (${attempt}. attempt)`)
        let secondsPassed = 0
        let timeParssedStr = ''
        while (secondsPassed < attempt) {
            await sleep(1000)
            secondsPassed += 1
            timeParssedStr = `${secondsPassed} second(s) has passsed`
            logger.warn(timeParssedStr)
        }

        try {
            return await this.ex[action.name](...args)
        } catch (e) {
            if (e instanceof ccxt.ExchangeError || e instanceof ccxt.NetworkError) {
                if (limit === attempt) {
                    logger.error(`Max retry reached (${limit} retries): ${action.name} (${args.join(',')}) | ${e.message}`)
                    process.exit(1)
                }
                attempt += 1
                return await this.retry(action, args, limit, attempt)
            } else {
                logger.error(`An unexpected error occured: retry | ${action.name} (${args.join(',')})`)
                process.exit(1)
            }

        }
    }

    async request(action, args = []) {
        try {
            logger.info(`Calling: ${action.name} (${args.join(',')})`)
            return await this.ex[action.name](...args)
        } catch (e) {
            if (e instanceof ccxt.NetworkError) {
                logger.error(`NetworkError: ${action.name} (${args.join(',')}) | ${e.message}`)
                // return await this.retry(action, args, 300, 1)
            } else if (e instanceof ccxt.ExchangeError) {
                logger.error(`ExchangeError: ${action.name} (${args.join(',')}) | ${e.message}`)
                // return await this.retry(action, args, 300, 1)
                // process.exit(1)
            } else {
                logger.error(`An unexpected error occured: request | ${action.name} (${args.join(',')}) | ${e}`)
                process.exit(1)
            }
        }
    }
}


module.exports = {
    Exchange
}