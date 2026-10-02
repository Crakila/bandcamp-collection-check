(function (root) {
  "use strict";
  const KEY = "bandcampConsent";
  const VERSION = 1;
  const DATA_TYPES = ["personallyIdentifyingInfo", "authenticationInfo", "browsingActivity", "websiteContent"];
  async function state(api) {
    const choice = (await api.storage.local.get(KEY))[KEY];
    let permissions;
    let permissionCheckFailed = false;
    try { permissions = await api.permissions?.getAll(); } catch { permissionCheckFailed = true; }
    const native = Array.isArray(permissions?.data_collection);
    const nativeAllowed = native && DATA_TYPES.every(type => permissions.data_collection.includes(type));
    const paused = choice?.version === VERSION && choice.allowed === false;
    const allowed = !paused && !permissionCheckFailed && (native ? nativeAllowed : choice?.version === VERSION && choice.allowed === true);
    return { allowed, native, nativeAllowed, paused, permissionCheckFailed, choiceRecorded: choice?.version === VERSION };
  }
  root.BCConsent = { KEY, VERSION, DATA_TYPES, state };
})(globalThis);
