// https://medium.com/@siriphonnot/%E0%B8%AA%E0%B8%A3%E0%B9%89%E0%B8%B2%E0%B8%87-logging-%E0%B9%80%E0%B8%97%E0%B8%9E%E0%B9%86-%E0%B8%94%E0%B9%89%E0%B8%A7%E0%B8%A2-winston-%E0%B9%83%E0%B8%99-node-js-b479f505ba3e
const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

const env = process.env.NODE_ENV
const logDir = 'log';

// Create the log directory if it does not exist
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

let transportsConfig = [new transports.Console({
    level: env === 'backtest' ? 'info' : 'debug',
    format: format.combine(
        format.colorize(),
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.printf(
            info => `[${info.timestamp}][${info.level}] ${info.message}`
        )
    )
})]

if (env !== 'backtest') {
    transportsConfig.push(new transports.File({ filename: path.join(logDir, process.env.NODE_ENV + '.log') }))
}

let config = {
    // change level if in dev environment versus production
    level: env === 'backtest' ? 'info' : 'debug',
    format: format.combine(
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.printf(info => `[${info.timestamp}][${info.level}] ${info.message}`)
    ),
    // You can also comment out the line above and uncomment the line below for JSON format
    // format: format.json(),
    transports: transportsConfig
}

const logger = createLogger(config);


module.exports = {
    logger
}