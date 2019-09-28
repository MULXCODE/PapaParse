/** Makes a deep copy of an array or object (mostly) */
import Any = jasmine.Any;

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


export function extend<T extends AnyObject>(base: T, ext: Partial<T>): T {
  return {
    ...base,
    ...mapObj(ext, (v, k) => (typeof v !== "undefined" ? v : base[k]))
  };
}

/**
 * Return a new object where any value appearing in source that doesn't exist in
 * the whitelist will revert to the fallback value
 *
 * @param source
 * @param whitelist
 * @param fallback
 */
export function whitelist<T, K extends AnyObject>(
  source: K,
  whitelist: T[],
  fallback?: T
): K {
  return mapObj(source, v => (whitelist.includes(v) ? v : fallback));
}

/**
 * Return a new object where any value appearing in source that also exists in
 * the blacklist will revert to the fallback value
 *
 * @param source Source object to check against
 * @param blacklist
 * @param fallback
 */
export function blacklist<T, K extends AnyObject>(
  source: K,
  blacklist: T[],
  fallback?: any
) {
  return mapObj(source, v => (blacklist.includes(v) ? fallback : v));
}

export interface AnyObject<T = any> {
  [key: string]: T;
}

export function mapObj<T extends AnyObject>(
  obj: T,
  fn: (value: any, key: string) => NotPromise<any>
): T {
  let out = { ...obj };
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      out = { ...out, ...{ [key]: fn(obj[key], key) } };
    }
  }
  return out;
}

type NotPromise<T> = T extends Promise<any> ? never : T;

export function isIn(v, s) {
  return v.indexOf(s) !== -1
}
