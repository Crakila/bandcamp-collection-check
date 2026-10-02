const fs = require("node:fs");
const path = require("node:path");
const declaredData = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).browser_specific_settings.gecko.data_collection_permissions.required;
function allowNativeConsent(api) {
  api.permissions = { getAll: async () => ({ data_collection: [...declaredData] }) };
}
module.exports = { allowNativeConsent };
