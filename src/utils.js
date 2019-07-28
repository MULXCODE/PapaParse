/* @flow */
/** Makes a deep copy of an array or object (mostly) */
export function copy(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  const cpy = Array.isArray(obj) ? [] : {};
  for (const key in obj) cpy[key] = copy(obj[key]);
  return cpy;
}

export function bindFunction(f, self) {
  return function() {
    f.apply(self, arguments);
  };
}

export function isFunction(func /* :any */) {
  return typeof func === "function";
}

/** https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions */
export function escapeRegExp(string /* :string */) /* :string */ {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}
