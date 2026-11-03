const { authorizePin } = require("../domain/paymentAuthorization");

function validatePIN(transaction) {
  console.log("🔐 System A - Validating PIN");
  return authorizePin(transaction);
}

module.exports = { validatePIN };
