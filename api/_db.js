const { MongoClient } = require('mongodb');
const { getRequiredEnv } = require('./_config');

let clientPromise;

function getClient() {
  if (!clientPromise) {
    const uri = getRequiredEnv('MONGODB_URI');
    const dbName = process.env.MONGODB_DB_NAME || 'securepay';
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      family: 4
    });
    clientPromise = client.connect().then(async connectedClient => {
      await connectedClient.db(dbName).command({ ping: 1 });
      return connectedClient;
    }).catch(error => {
      clientPromise = undefined;
      const message = String(error && error.message || error);
      if (/bad auth|authentication failed/i.test(message)) {
        throw new Error('MongoDB authentication failed. Check the username, password, and database user permissions in MONGODB_URI.');
      }
      if (/ENOTFOUND|ECONNREFUSED|server selection/i.test(message)) {
        throw new Error('MongoDB is unreachable. Check that MongoDB is running locally or that the Atlas network access list allows this machine.');
      }
      throw error;
    });
  }
  return clientPromise;
}

async function getDatabase() {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB_NAME || 'securepay');
}

module.exports = { getClient, getDatabase };
