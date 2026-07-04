const config = {
  port: Number(process.env.PORT) || 3000,
  workerCount: Number(process.env.WORKER_COUNT) || 3,
  maxRetries: Number(process.env.MAX_RETRIES) || 3,
  transactionLimit: Number(process.env.TRANSACTION_LIMIT) || 10000,

  supportedIssuerTypes: ["INTERNAL", "EXTERNAL"],

  supportedNetworks: ["EXTERNAL_PROCESSOR", "CARD_NETWORK"],

  supportedTransactionTypes: [
    "PURCHASE",
    "CASH_WITHDRAWAL",
    "BALANCE_INQUIRY",
    "REVERSAL"
  ],

  supportedChannels: [
    "DOMESTIC_ATM",
    "INTERNATIONAL_ATM",
    "DOMESTIC_POS",
    "INTERNATIONAL_POS",
    "ECOM"
  ],

  riskRules: {
    internationalAtmLimit: 1000,
    ecommerceReviewLimit: 5000,
    internationalPosReviewLimit: 3000,
  },
}

function validateRuntimeConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const required = ["DATABASE_URL", "CARD_FINGERPRINT_SECRET"];
  for (const name of required) {
    if (!env[name]) {
      throw new Error(`${name} must be set when NODE_ENV=production`);
    }
  }

  if (!env.REDIS_URL && !env.REDIS_HOST) {
    throw new Error("REDIS_URL or REDIS_HOST must be set when NODE_ENV=production");
  }
}

module.exports = { config, validateRuntimeConfiguration };
