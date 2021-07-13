const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

const getDb = (botId)=>{
    const adapter = new FileSync(`db/${botId}.json`)
    const db = low(adapter)
    return db
}

module.exports = {
    getDb
}