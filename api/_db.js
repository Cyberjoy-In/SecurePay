const { MongoClient } = require('mongodb');
const { getRequiredEnv } = require('./_config');

let clientPromise;

function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(getRequiredEnv('MONGODB_URI'));
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDatabase() {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB_NAME || 'securepay');
}

module.exports = { getClient, getDatabase };