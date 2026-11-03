const { routeTransaction: routeDomainTransaction } = require("../domain/transactionRouting");

function routeTransaction(transaction) {
  console.log("BROKER_RECEIVED_TXN");
  return routeDomainTransaction(transaction);
}

module.exports = { routeTransaction };
