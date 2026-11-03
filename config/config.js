const {
  SUPPORTED_ISSUER_TYPES,
  SUPPORTED_PAYMENT_NETWORKS,
  SUPPORTED_TRANSACTION_CHANNELS,
  SUPPORTED_TRANSACTION_TYPES,
} = require("../domain/transactionConstants");
const {
  DEFAULT_RISK_RULES,
  DEFAULT_TRANSACTION_LIMIT,
} = require("../domain/paymentPolicy");

const config = {
  port: Number(process.env.PORT) || 3000,
  workerCount: Number(process.env.WORKER_COUNT) || 3,
  maxRetries: Number(process.env.MAX_RETRIES) || 3,
  transactionLimit:
    Number(process.env.TRANSACTION_LIMIT) || DEFAULT_TRANSACTION_LIMIT,

  supportedIssuerTypes: SUPPORTED_ISSUER_TYPES,

  supportedNetworks: SUPPORTED_PAYMENT_NETWORKS,

  supportedTransactionTypes: SUPPORTED_TRANSACTION_TYPES,

  supportedChannels: SUPPORTED_TRANSACTION_CHANNELS,

  riskRules: DEFAULT_RISK_RULES,
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
