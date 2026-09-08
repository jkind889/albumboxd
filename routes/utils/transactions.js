function isTransactionUnavailable(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === 20
    || error?.codeName === "IllegalOperation"
    || message.includes("transaction numbers are only allowed")
    || message.includes("transactions are not supported")
    || message.includes("replica set");
}

module.exports = { isTransactionUnavailable };
