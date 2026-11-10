import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag2) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag2.startsWith(prefix))
            return handle + escapeTagName(tag2.substring(prefix.length));
        }
        return tag2[0] === "!" ? tag2 : `!<${tag2}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count: count2, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count2);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        if (found && ctx) {
          const { anchors: anchors2, doc: doc2, maxAliasCount } = ctx;
          let data = anchors2.get(found);
          if (!data) {
            toJS.toJS(found, null, ctx);
            data = anchors2.get(found);
          }
          if (data?.res === void 0) {
            const msg = "This should not happen: Alias anchor was not resolved?";
            throw new ReferenceError(msg);
          }
          if (maxAliasCount >= 0) {
            data.count += 1;
            if (data.aliasCount === 0)
              data.aliasCount = getAliasCount(doc2, found, anchors2);
            if (data.count * data.aliasCount > maxAliasCount) {
              const msg = "Excessive alias count indicates a resource exhaustion attack";
              throw new ReferenceError(msg);
            }
          }
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const source = this.resolve(ctx.doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        return ctx.anchors.get(source).res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count2 = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count2)
            count2 = c;
        }
        return count2;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag2) => tag2.default && tag2.tag !== "tag:yaml.org,2002:str" && tag2.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag2 = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag2)
        props.push(doc.directives.tagString(tag2));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag2) => tag2.tag === merge.tag && tag2.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log2 = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log2.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag: tag2, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag2 || tag2 === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag2 of customTags)
          tags = tags.concat(tag2);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag2) => {
        const tagObj = typeof tag2 === "string" ? tagsByName[tag2] : tag2;
        if (!tagObj) {
          const tagName = JSON.stringify(tag2);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag: tag2 } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag2, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count: count2, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count2);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message2) {
        super();
        this.name = name;
        this.code = code;
        this.message = message2;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message2) {
        super("YAMLParseError", pos, code, message2);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message2) {
        super("YAMLWarning", pos, code, message2);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count2 = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count2 = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count2);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag2 = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag2)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag2)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag2 = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag2)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag: tag2,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag2) {
      const NodeClass = tag2?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag2) {
      const NodeClass = tag2?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag2) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag2?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag2) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag2) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag2) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag2);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message2 = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message2);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag2 = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag2) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag2 = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag2);
      const res = tag2.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag2?.format)
        node.format = tag2.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message2 = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message2);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message2 = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message2);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message2 = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message2);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message2 = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message2);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message2 = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message2);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return unfoldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function unfoldLines(source) {
      const line = /(.*?)\r?\n/sy;
      let match = line.exec(source);
      if (!match)
        return source;
      let trimEnd, trimBoth;
      try {
        trimEnd = new RegExp("(?<![ 	])[ 	]+$");
        trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
      } catch {
        trimEnd = /[ \t]+$/;
        trimBoth = /^[ \t]+|[ \t]+$/g;
      }
      let res = match[1].replace(trimEnd, "");
      let sep2 = " ";
      let pos = line.lastIndex;
      while (match = line.exec(source)) {
        const lm = match[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + lm;
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag2;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag2 = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag2 = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag2 = findScalarTagByTest(ctx, value, token, onError);
      else
        tag2 = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag2.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag2.format)
        scalar.format = tag2.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag2 of schema.tags) {
        if (!tag2.collection && tag2.tag === tagName) {
          if (tag2.default && tag2.test)
            matchWithTest.push(tag2);
          else
            return tag2;
        }
      }
      for (const tag2 of matchWithTest)
        if (tag2.test?.test(value))
          return tag2;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag2 = schema.tags.find((tag3) => (tag3.default === true || atKey && tag3.default === "key") && tag3.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag3) => tag3.default && tag3.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag2.tag !== compat.tag) {
          const ts = directives.tagString(tag2.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag2;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag: tag2 } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag2)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag2, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message2 = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message2);
          }
          break;
        default: {
          const message2 = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message2);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag2 ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag: tag2, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag2, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message2, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message2));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message2));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message2, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message2, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message2) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message2);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message2);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list2, type) {
      for (let i = 0; i < list2.length; ++i)
        if (list2[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list2) {
      for (let i = 0; i < list2.length; ++i) {
        switch (list2[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser3 = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message2 = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message: message2, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message2 = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message: message2 };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser3;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log2 = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log2.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify;
  }
});

// node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
    var _CodeOrName = class {
    };
    exports._CodeOrName = _CodeOrName;
    exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
    var Name = class extends _CodeOrName {
      constructor(s) {
        super();
        if (!exports.IDENTIFIER.test(s))
          throw new Error("CodeGen: name must be a valid identifier");
        this.str = s;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        return false;
      }
      get names() {
        return { [this.str]: 1 };
      }
    };
    exports.Name = Name;
    var _Code = class extends _CodeOrName {
      constructor(code) {
        super();
        this._items = typeof code === "string" ? [code] : code;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        if (this._items.length > 1)
          return false;
        const item = this._items[0];
        return item === "" || item === '""';
      }
      get str() {
        var _a;
        return (_a = this._str) !== null && _a !== void 0 ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
      }
      get names() {
        var _a;
        return (_a = this._names) !== null && _a !== void 0 ? _a : this._names = this._items.reduce((names, c) => {
          if (c instanceof Name)
            names[c.str] = (names[c.str] || 0) + 1;
          return names;
        }, {});
      }
    };
    exports._Code = _Code;
    exports.nil = new _Code("");
    function _(strs, ...args) {
      const code = [strs[0]];
      let i = 0;
      while (i < args.length) {
        addCodeArg(code, args[i]);
        code.push(strs[++i]);
      }
      return new _Code(code);
    }
    exports._ = _;
    var plus = new _Code("+");
    function str(strs, ...args) {
      const expr = [safeStringify(strs[0])];
      let i = 0;
      while (i < args.length) {
        expr.push(plus);
        addCodeArg(expr, args[i]);
        expr.push(plus, safeStringify(strs[++i]));
      }
      optimize(expr);
      return new _Code(expr);
    }
    exports.str = str;
    function addCodeArg(code, arg) {
      if (arg instanceof _Code)
        code.push(...arg._items);
      else if (arg instanceof Name)
        code.push(arg);
      else
        code.push(interpolate(arg));
    }
    exports.addCodeArg = addCodeArg;
    function optimize(expr) {
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === plus) {
          const res = mergeExprItems(expr[i - 1], expr[i + 1]);
          if (res !== void 0) {
            expr.splice(i - 1, 3, res);
            continue;
          }
          expr[i++] = "+";
        }
        i++;
      }
    }
    function mergeExprItems(a, b) {
      if (b === '""')
        return a;
      if (a === '""')
        return b;
      if (typeof a == "string") {
        if (b instanceof Name || a[a.length - 1] !== '"')
          return;
        if (typeof b != "string")
          return `${a.slice(0, -1)}${b}"`;
        if (b[0] === '"')
          return a.slice(0, -1) + b.slice(1);
        return;
      }
      if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
        return `"${a}${b.slice(1)}`;
      return;
    }
    function strConcat(c1, c2) {
      return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
    }
    exports.strConcat = strConcat;
    function interpolate(x) {
      return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
    }
    function stringify(x) {
      return new _Code(safeStringify(x));
    }
    exports.stringify = stringify;
    function safeStringify(x) {
      return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    exports.safeStringify = safeStringify;
    function getProperty(key) {
      return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
    }
    exports.getProperty = getProperty;
    function getEsmExportName(key) {
      if (typeof key == "string" && exports.IDENTIFIER.test(key)) {
        return new _Code(`${key}`);
      }
      throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
    }
    exports.getEsmExportName = getEsmExportName;
    function regexpCode(rx) {
      return new _Code(rx.toString());
    }
    exports.regexpCode = regexpCode;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/scope.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
    var code_1 = require_code();
    var ValueError = class extends Error {
      constructor(name) {
        super(`CodeGen: "code" for ${name} not defined`);
        this.value = name.value;
      }
    };
    var UsedValueState;
    (function(UsedValueState2) {
      UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
      UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
    })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
    exports.varKinds = {
      const: new code_1.Name("const"),
      let: new code_1.Name("let"),
      var: new code_1.Name("var")
    };
    var Scope = class {
      constructor({ prefixes, parent } = {}) {
        this._names = {};
        this._prefixes = prefixes;
        this._parent = parent;
      }
      toName(nameOrPrefix) {
        return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
      }
      name(prefix) {
        return new code_1.Name(this._newName(prefix));
      }
      _newName(prefix) {
        const ng = this._names[prefix] || this._nameGroup(prefix);
        return `${prefix}${ng.index++}`;
      }
      _nameGroup(prefix) {
        var _a, _b;
        if (((_b = (_a = this._parent) === null || _a === void 0 ? void 0 : _a._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
          throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
        }
        return this._names[prefix] = { prefix, index: 0 };
      }
    };
    exports.Scope = Scope;
    var ValueScopeName = class extends code_1.Name {
      constructor(prefix, nameStr) {
        super(nameStr);
        this.prefix = prefix;
      }
      setValue(value, { property, itemIndex }) {
        this.value = value;
        this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
      }
    };
    exports.ValueScopeName = ValueScopeName;
    var line = (0, code_1._)`\n`;
    var ValueScope = class extends Scope {
      constructor(opts) {
        super(opts);
        this._values = {};
        this._scope = opts.scope;
        this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
      }
      get() {
        return this._scope;
      }
      name(prefix) {
        return new ValueScopeName(prefix, this._newName(prefix));
      }
      value(nameOrPrefix, value) {
        var _a;
        if (value.ref === void 0)
          throw new Error("CodeGen: ref must be passed in value");
        const name = this.toName(nameOrPrefix);
        const { prefix } = name;
        const valueKey = (_a = value.key) !== null && _a !== void 0 ? _a : value.ref;
        let vs = this._values[prefix];
        if (vs) {
          const _name = vs.get(valueKey);
          if (_name)
            return _name;
        } else {
          vs = this._values[prefix] = /* @__PURE__ */ new Map();
        }
        vs.set(valueKey, name);
        const s = this._scope[prefix] || (this._scope[prefix] = []);
        const itemIndex = s.length;
        s[itemIndex] = value.ref;
        name.setValue(value, { property: prefix, itemIndex });
        return name;
      }
      getValue(prefix, keyOrRef) {
        const vs = this._values[prefix];
        if (!vs)
          return;
        return vs.get(keyOrRef);
      }
      scopeRefs(scopeName, values = this._values) {
        return this._reduceValues(values, (name) => {
          if (name.scopePath === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return (0, code_1._)`${scopeName}${name.scopePath}`;
        });
      }
      scopeCode(values = this._values, usedValues, getCode) {
        return this._reduceValues(values, (name) => {
          if (name.value === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return name.value.code;
        }, usedValues, getCode);
      }
      _reduceValues(values, valueCode, usedValues = {}, getCode) {
        let code = code_1.nil;
        for (const prefix in values) {
          const vs = values[prefix];
          if (!vs)
            continue;
          const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
          vs.forEach((name) => {
            if (nameSet.has(name))
              return;
            nameSet.set(name, UsedValueState.Started);
            let c = valueCode(name);
            if (c) {
              const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
              code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
            } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) {
              code = (0, code_1._)`${code}${c}${this.opts._n}`;
            } else {
              throw new ValueError(name);
            }
            nameSet.set(name, UsedValueState.Completed);
          });
        }
        return code;
      }
    };
    exports.ValueScope = ValueScope;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
    var code_1 = require_code();
    var scope_1 = require_scope();
    var code_2 = require_code();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return code_2._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return code_2.str;
    } });
    Object.defineProperty(exports, "strConcat", { enumerable: true, get: function() {
      return code_2.strConcat;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return code_2.nil;
    } });
    Object.defineProperty(exports, "getProperty", { enumerable: true, get: function() {
      return code_2.getProperty;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return code_2.stringify;
    } });
    Object.defineProperty(exports, "regexpCode", { enumerable: true, get: function() {
      return code_2.regexpCode;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return code_2.Name;
    } });
    var scope_2 = require_scope();
    Object.defineProperty(exports, "Scope", { enumerable: true, get: function() {
      return scope_2.Scope;
    } });
    Object.defineProperty(exports, "ValueScope", { enumerable: true, get: function() {
      return scope_2.ValueScope;
    } });
    Object.defineProperty(exports, "ValueScopeName", { enumerable: true, get: function() {
      return scope_2.ValueScopeName;
    } });
    Object.defineProperty(exports, "varKinds", { enumerable: true, get: function() {
      return scope_2.varKinds;
    } });
    exports.operators = {
      GT: new code_1._Code(">"),
      GTE: new code_1._Code(">="),
      LT: new code_1._Code("<"),
      LTE: new code_1._Code("<="),
      EQ: new code_1._Code("==="),
      NEQ: new code_1._Code("!=="),
      NOT: new code_1._Code("!"),
      OR: new code_1._Code("||"),
      AND: new code_1._Code("&&"),
      ADD: new code_1._Code("+")
    };
    var Node = class {
      optimizeNodes() {
        return this;
      }
      optimizeNames(_names, _constants) {
        return this;
      }
    };
    var Def = class extends Node {
      constructor(varKind, name, rhs) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.rhs = rhs;
      }
      render({ es5, _n }) {
        const varKind = es5 ? scope_1.varKinds.var : this.varKind;
        const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
        return `${varKind} ${this.name}${rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (!names[this.name.str])
          return;
        if (this.rhs)
          this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
      }
    };
    var Assign = class extends Node {
      constructor(lhs, rhs, sideEffects) {
        super();
        this.lhs = lhs;
        this.rhs = rhs;
        this.sideEffects = sideEffects;
      }
      render({ _n }) {
        return `${this.lhs} = ${this.rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
          return;
        this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
        return addExprNames(names, this.rhs);
      }
    };
    var AssignOp = class extends Assign {
      constructor(lhs, op, rhs, sideEffects) {
        super(lhs, rhs, sideEffects);
        this.op = op;
      }
      render({ _n }) {
        return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
      }
    };
    var Label = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        return `${this.label}:` + _n;
      }
    };
    var Break = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        const label = this.label ? ` ${this.label}` : "";
        return `break${label};` + _n;
      }
    };
    var Throw = class extends Node {
      constructor(error) {
        super();
        this.error = error;
      }
      render({ _n }) {
        return `throw ${this.error};` + _n;
      }
      get names() {
        return this.error.names;
      }
    };
    var AnyCode = class extends Node {
      constructor(code) {
        super();
        this.code = code;
      }
      render({ _n }) {
        return `${this.code};` + _n;
      }
      optimizeNodes() {
        return `${this.code}` ? this : void 0;
      }
      optimizeNames(names, constants) {
        this.code = optimizeExpr(this.code, names, constants);
        return this;
      }
      get names() {
        return this.code instanceof code_1._CodeOrName ? this.code.names : {};
      }
    };
    var ParentNode = class extends Node {
      constructor(nodes = []) {
        super();
        this.nodes = nodes;
      }
      render(opts) {
        return this.nodes.reduce((code, n) => code + n.render(opts), "");
      }
      optimizeNodes() {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i].optimizeNodes();
          if (Array.isArray(n))
            nodes.splice(i, 1, ...n);
          else if (n)
            nodes[i] = n;
          else
            nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      optimizeNames(names, constants) {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i];
          if (n.optimizeNames(names, constants))
            continue;
          subtractNames(names, n.names);
          nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      get names() {
        return this.nodes.reduce((names, n) => addNames(names, n.names), {});
      }
    };
    var BlockNode = class extends ParentNode {
      render(opts) {
        return "{" + opts._n + super.render(opts) + "}" + opts._n;
      }
    };
    var Root = class extends ParentNode {
    };
    var Else = class extends BlockNode {
    };
    Else.kind = "else";
    var If = class _If extends BlockNode {
      constructor(condition, nodes) {
        super(nodes);
        this.condition = condition;
      }
      render(opts) {
        let code = `if(${this.condition})` + super.render(opts);
        if (this.else)
          code += "else " + this.else.render(opts);
        return code;
      }
      optimizeNodes() {
        super.optimizeNodes();
        const cond = this.condition;
        if (cond === true)
          return this.nodes;
        let e = this.else;
        if (e) {
          const ns = e.optimizeNodes();
          e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
        }
        if (e) {
          if (cond === false)
            return e instanceof _If ? e : e.nodes;
          if (this.nodes.length)
            return this;
          return new _If(not(cond), e instanceof _If ? [e] : e.nodes);
        }
        if (cond === false || !this.nodes.length)
          return void 0;
        return this;
      }
      optimizeNames(names, constants) {
        var _a;
        this.else = (_a = this.else) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        if (!(super.optimizeNames(names, constants) || this.else))
          return;
        this.condition = optimizeExpr(this.condition, names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        addExprNames(names, this.condition);
        if (this.else)
          addNames(names, this.else.names);
        return names;
      }
    };
    If.kind = "if";
    var For = class extends BlockNode {
    };
    For.kind = "for";
    var ForLoop = class extends For {
      constructor(iteration) {
        super();
        this.iteration = iteration;
      }
      render(opts) {
        return `for(${this.iteration})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iteration = optimizeExpr(this.iteration, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iteration.names);
      }
    };
    var ForRange = class extends For {
      constructor(varKind, name, from, to) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.from = from;
        this.to = to;
      }
      render(opts) {
        const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
        const { name, from, to } = this;
        return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
      }
      get names() {
        const names = addExprNames(super.names, this.from);
        return addExprNames(names, this.to);
      }
    };
    var ForIter = class extends For {
      constructor(loop, varKind, name, iterable) {
        super();
        this.loop = loop;
        this.varKind = varKind;
        this.name = name;
        this.iterable = iterable;
      }
      render(opts) {
        return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iterable = optimizeExpr(this.iterable, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iterable.names);
      }
    };
    var Func = class extends BlockNode {
      constructor(name, args, async) {
        super();
        this.name = name;
        this.args = args;
        this.async = async;
      }
      render(opts) {
        const _async = this.async ? "async " : "";
        return `${_async}function ${this.name}(${this.args})` + super.render(opts);
      }
    };
    Func.kind = "func";
    var Return = class extends ParentNode {
      render(opts) {
        return "return " + super.render(opts);
      }
    };
    Return.kind = "return";
    var Try = class extends BlockNode {
      render(opts) {
        let code = "try" + super.render(opts);
        if (this.catch)
          code += this.catch.render(opts);
        if (this.finally)
          code += this.finally.render(opts);
        return code;
      }
      optimizeNodes() {
        var _a, _b;
        super.optimizeNodes();
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNodes();
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNodes();
        return this;
      }
      optimizeNames(names, constants) {
        var _a, _b;
        super.optimizeNames(names, constants);
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNames(names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        if (this.catch)
          addNames(names, this.catch.names);
        if (this.finally)
          addNames(names, this.finally.names);
        return names;
      }
    };
    var Catch = class extends BlockNode {
      constructor(error) {
        super();
        this.error = error;
      }
      render(opts) {
        return `catch(${this.error})` + super.render(opts);
      }
    };
    Catch.kind = "catch";
    var Finally = class extends BlockNode {
      render(opts) {
        return "finally" + super.render(opts);
      }
    };
    Finally.kind = "finally";
    var CodeGen = class {
      constructor(extScope, opts = {}) {
        this._values = {};
        this._blockStarts = [];
        this._constants = {};
        this.opts = { ...opts, _n: opts.lines ? "\n" : "" };
        this._extScope = extScope;
        this._scope = new scope_1.Scope({ parent: extScope });
        this._nodes = [new Root()];
      }
      toString() {
        return this._root.render(this.opts);
      }
      // returns unique name in the internal scope
      name(prefix) {
        return this._scope.name(prefix);
      }
      // reserves unique name in the external scope
      scopeName(prefix) {
        return this._extScope.name(prefix);
      }
      // reserves unique name in the external scope and assigns value to it
      scopeValue(prefixOrName, value) {
        const name = this._extScope.value(prefixOrName, value);
        const vs = this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set());
        vs.add(name);
        return name;
      }
      getScopeValue(prefix, keyOrRef) {
        return this._extScope.getValue(prefix, keyOrRef);
      }
      // return code that assigns values in the external scope to the names that are used internally
      // (same names that were returned by gen.scopeName or gen.scopeValue)
      scopeRefs(scopeName) {
        return this._extScope.scopeRefs(scopeName, this._values);
      }
      scopeCode() {
        return this._extScope.scopeCode(this._values);
      }
      _def(varKind, nameOrPrefix, rhs, constant) {
        const name = this._scope.toName(nameOrPrefix);
        if (rhs !== void 0 && constant)
          this._constants[name.str] = rhs;
        this._leafNode(new Def(varKind, name, rhs));
        return name;
      }
      // `const` declaration (`var` in es5 mode)
      const(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
      }
      // `let` declaration with optional assignment (`var` in es5 mode)
      let(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
      }
      // `var` declaration with optional assignment
      var(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
      }
      // assignment code
      assign(lhs, rhs, sideEffects) {
        return this._leafNode(new Assign(lhs, rhs, sideEffects));
      }
      // `+=` code
      add(lhs, rhs) {
        return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
      }
      // appends passed SafeExpr to code or executes Block
      code(c) {
        if (typeof c == "function")
          c();
        else if (c !== code_1.nil)
          this._leafNode(new AnyCode(c));
        return this;
      }
      // returns code for object literal for the passed argument list of key-value pairs
      object(...keyValues) {
        const code = ["{"];
        for (const [key, value] of keyValues) {
          if (code.length > 1)
            code.push(",");
          code.push(key);
          if (key !== value || this.opts.es5) {
            code.push(":");
            (0, code_1.addCodeArg)(code, value);
          }
        }
        code.push("}");
        return new code_1._Code(code);
      }
      // `if` clause (or statement if `thenBody` and, optionally, `elseBody` are passed)
      if(condition, thenBody, elseBody) {
        this._blockNode(new If(condition));
        if (thenBody && elseBody) {
          this.code(thenBody).else().code(elseBody).endIf();
        } else if (thenBody) {
          this.code(thenBody).endIf();
        } else if (elseBody) {
          throw new Error('CodeGen: "else" body without "then" body');
        }
        return this;
      }
      // `else if` clause - invalid without `if` or after `else` clauses
      elseIf(condition) {
        return this._elseNode(new If(condition));
      }
      // `else` clause - only valid after `if` or `else if` clauses
      else() {
        return this._elseNode(new Else());
      }
      // end `if` statement (needed if gen.if was used only with condition)
      endIf() {
        return this._endBlockNode(If, Else);
      }
      _for(node, forBody) {
        this._blockNode(node);
        if (forBody)
          this.code(forBody).endFor();
        return this;
      }
      // a generic `for` clause (or statement if `forBody` is passed)
      for(iteration, forBody) {
        return this._for(new ForLoop(iteration), forBody);
      }
      // `for` statement for a range of values
      forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
      }
      // `for-of` statement (in es5 mode replace with a normal for loop)
      forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
        const name = this._scope.toName(nameOrPrefix);
        if (this.opts.es5) {
          const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
          return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
            this.var(name, (0, code_1._)`${arr}[${i}]`);
            forBody(name);
          });
        }
        return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
      }
      // `for-in` statement.
      // With option `ownProperties` replaced with a `for-of` loop for object keys
      forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
        if (this.opts.ownProperties) {
          return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
        }
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
      }
      // end `for` loop
      endFor() {
        return this._endBlockNode(For);
      }
      // `label` statement
      label(label) {
        return this._leafNode(new Label(label));
      }
      // `break` statement
      break(label) {
        return this._leafNode(new Break(label));
      }
      // `return` statement
      return(value) {
        const node = new Return();
        this._blockNode(node);
        this.code(value);
        if (node.nodes.length !== 1)
          throw new Error('CodeGen: "return" should have one node');
        return this._endBlockNode(Return);
      }
      // `try` statement
      try(tryBody, catchCode, finallyCode) {
        if (!catchCode && !finallyCode)
          throw new Error('CodeGen: "try" without "catch" and "finally"');
        const node = new Try();
        this._blockNode(node);
        this.code(tryBody);
        if (catchCode) {
          const error = this.name("e");
          this._currNode = node.catch = new Catch(error);
          catchCode(error);
        }
        if (finallyCode) {
          this._currNode = node.finally = new Finally();
          this.code(finallyCode);
        }
        return this._endBlockNode(Catch, Finally);
      }
      // `throw` statement
      throw(error) {
        return this._leafNode(new Throw(error));
      }
      // start self-balancing block
      block(body, nodeCount) {
        this._blockStarts.push(this._nodes.length);
        if (body)
          this.code(body).endBlock(nodeCount);
        return this;
      }
      // end the current self-balancing block
      endBlock(nodeCount) {
        const len = this._blockStarts.pop();
        if (len === void 0)
          throw new Error("CodeGen: not in self-balancing block");
        const toClose = this._nodes.length - len;
        if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) {
          throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
        }
        this._nodes.length = len;
        return this;
      }
      // `function` heading (or definition if funcBody is passed)
      func(name, args = code_1.nil, async, funcBody) {
        this._blockNode(new Func(name, args, async));
        if (funcBody)
          this.code(funcBody).endFunc();
        return this;
      }
      // end function definition
      endFunc() {
        return this._endBlockNode(Func);
      }
      optimize(n = 1) {
        while (n-- > 0) {
          this._root.optimizeNodes();
          this._root.optimizeNames(this._root.names, this._constants);
        }
      }
      _leafNode(node) {
        this._currNode.nodes.push(node);
        return this;
      }
      _blockNode(node) {
        this._currNode.nodes.push(node);
        this._nodes.push(node);
      }
      _endBlockNode(N1, N2) {
        const n = this._currNode;
        if (n instanceof N1 || N2 && n instanceof N2) {
          this._nodes.pop();
          return this;
        }
        throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
      }
      _elseNode(node) {
        const n = this._currNode;
        if (!(n instanceof If)) {
          throw new Error('CodeGen: "else" without "if"');
        }
        this._currNode = n.else = node;
        return this;
      }
      get _root() {
        return this._nodes[0];
      }
      get _currNode() {
        const ns = this._nodes;
        return ns[ns.length - 1];
      }
      set _currNode(node) {
        const ns = this._nodes;
        ns[ns.length - 1] = node;
      }
    };
    exports.CodeGen = CodeGen;
    function addNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) + (from[n] || 0);
      return names;
    }
    function addExprNames(names, from) {
      return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
    }
    function optimizeExpr(expr, names, constants) {
      if (expr instanceof code_1.Name)
        return replaceName(expr);
      if (!canOptimize(expr))
        return expr;
      return new code_1._Code(expr._items.reduce((items, c) => {
        if (c instanceof code_1.Name)
          c = replaceName(c);
        if (c instanceof code_1._Code)
          items.push(...c._items);
        else
          items.push(c);
        return items;
      }, []));
      function replaceName(n) {
        const c = constants[n.str];
        if (c === void 0 || names[n.str] !== 1)
          return n;
        delete names[n.str];
        return c;
      }
      function canOptimize(e) {
        return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
      }
    }
    function subtractNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) - (from[n] || 0);
    }
    function not(x) {
      return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
    }
    exports.not = not;
    var andCode = mappend(exports.operators.AND);
    function and(...args) {
      return args.reduce(andCode);
    }
    exports.and = and;
    var orCode = mappend(exports.operators.OR);
    function or(...args) {
      return args.reduce(orCode);
    }
    exports.or = or;
    function mappend(op) {
      return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
    }
    function par(x) {
      return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/util.js
var require_util = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/util.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
    var codegen_1 = require_codegen();
    var code_1 = require_code();
    function toHash(arr) {
      const hash = {};
      for (const item of arr)
        hash[item] = true;
      return hash;
    }
    exports.toHash = toHash;
    function alwaysValidSchema(it, schema) {
      if (typeof schema == "boolean")
        return schema;
      if (Object.keys(schema).length === 0)
        return true;
      checkUnknownRules(it, schema);
      return !schemaHasRules(schema, it.self.RULES.all);
    }
    exports.alwaysValidSchema = alwaysValidSchema;
    function checkUnknownRules(it, schema = it.schema) {
      const { opts, self } = it;
      if (!opts.strictSchema)
        return;
      if (typeof schema === "boolean")
        return;
      const rules = self.RULES.keywords;
      for (const key in schema) {
        if (!rules[key])
          checkStrictMode(it, `unknown keyword: "${key}"`);
      }
    }
    exports.checkUnknownRules = checkUnknownRules;
    function schemaHasRules(schema, rules) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (rules[key])
          return true;
      return false;
    }
    exports.schemaHasRules = schemaHasRules;
    function schemaHasRulesButRef(schema, RULES) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (key !== "$ref" && RULES.all[key])
          return true;
      return false;
    }
    exports.schemaHasRulesButRef = schemaHasRulesButRef;
    function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
      if (!$data) {
        if (typeof schema == "number" || typeof schema == "boolean")
          return schema;
        if (typeof schema == "string")
          return (0, codegen_1._)`${schema}`;
      }
      return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
    }
    exports.schemaRefOrVal = schemaRefOrVal;
    function unescapeFragment(str) {
      return unescapeJsonPointer(decodeURIComponent(str));
    }
    exports.unescapeFragment = unescapeFragment;
    function escapeFragment(str) {
      return encodeURIComponent(escapeJsonPointer(str));
    }
    exports.escapeFragment = escapeFragment;
    function escapeJsonPointer(str) {
      if (typeof str == "number")
        return `${str}`;
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    exports.escapeJsonPointer = escapeJsonPointer;
    function unescapeJsonPointer(str) {
      return str.replace(/~1/g, "/").replace(/~0/g, "~");
    }
    exports.unescapeJsonPointer = unescapeJsonPointer;
    function eachItem(xs, f) {
      if (Array.isArray(xs)) {
        for (const x of xs)
          f(x);
      } else {
        f(xs);
      }
    }
    exports.eachItem = eachItem;
    function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
      return (gen, from, to, toName) => {
        const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
        return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
      };
    }
    exports.mergeEvaluated = {
      props: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
          gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
        }),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
          if (from === true) {
            gen.assign(to, true);
          } else {
            gen.assign(to, (0, codegen_1._)`${to} || {}`);
            setEvaluated(gen, to, from);
          }
        }),
        mergeValues: (from, to) => from === true ? true : { ...from, ...to },
        resultToName: evaluatedPropsToName
      }),
      items: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
        mergeValues: (from, to) => from === true ? true : Math.max(from, to),
        resultToName: (gen, items) => gen.var("items", items)
      })
    };
    function evaluatedPropsToName(gen, ps) {
      if (ps === true)
        return gen.var("props", true);
      const props = gen.var("props", (0, codegen_1._)`{}`);
      if (ps !== void 0)
        setEvaluated(gen, props, ps);
      return props;
    }
    exports.evaluatedPropsToName = evaluatedPropsToName;
    function setEvaluated(gen, props, ps) {
      Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
    }
    exports.setEvaluated = setEvaluated;
    var snippets = {};
    function useFunc(gen, f) {
      return gen.scopeValue("func", {
        ref: f,
        code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
      });
    }
    exports.useFunc = useFunc;
    var Type;
    (function(Type2) {
      Type2[Type2["Num"] = 0] = "Num";
      Type2[Type2["Str"] = 1] = "Str";
    })(Type || (exports.Type = Type = {}));
    function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
      if (dataProp instanceof codegen_1.Name) {
        const isNumber = dataPropType === Type.Num;
        return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
      }
      return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
    }
    exports.getErrorPath = getErrorPath;
    function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
      if (!mode)
        return;
      msg = `strict mode: ${msg}`;
      if (mode === true)
        throw new Error(msg);
      it.self.logger.warn(msg);
    }
    exports.checkStrictMode = checkStrictMode;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/names.js
var require_names = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/names.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var names = {
      // validation function arguments
      data: new codegen_1.Name("data"),
      // data passed to validation function
      // args passed from referencing schema
      valCxt: new codegen_1.Name("valCxt"),
      // validation/data context - should not be used directly, it is destructured to the names below
      instancePath: new codegen_1.Name("instancePath"),
      parentData: new codegen_1.Name("parentData"),
      parentDataProperty: new codegen_1.Name("parentDataProperty"),
      rootData: new codegen_1.Name("rootData"),
      // root data - same as the data passed to the first/top validation function
      dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
      // used to support recursiveRef and dynamicRef
      // function scoped variables
      vErrors: new codegen_1.Name("vErrors"),
      // null or array of validation errors
      errors: new codegen_1.Name("errors"),
      // counter of validation errors
      this: new codegen_1.Name("this"),
      // "globals"
      self: new codegen_1.Name("self"),
      scope: new codegen_1.Name("scope"),
      // JTD serialize/parse name for JSON string and position
      json: new codegen_1.Name("json"),
      jsonPos: new codegen_1.Name("jsonPos"),
      jsonLen: new codegen_1.Name("jsonLen"),
      jsonPart: new codegen_1.Name("jsonPart")
    };
    exports.default = names;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/errors.js
var require_errors2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/errors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    exports.keywordError = {
      message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
    };
    exports.keyword$DataError = {
      message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
    };
    function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) {
        addError(gen, errObj);
      } else {
        returnErrors(it, (0, codegen_1._)`[${errObj}]`);
      }
    }
    exports.reportError = reportError;
    function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      addError(gen, errObj);
      if (!(compositeRule || allErrors)) {
        returnErrors(it, names_1.default.vErrors);
      }
    }
    exports.reportExtraError = reportExtraError;
    function resetErrorsCount(gen, errsCount) {
      gen.assign(names_1.default.errors, errsCount);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
    }
    exports.resetErrorsCount = resetErrorsCount;
    function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
      if (errsCount === void 0)
        throw new Error("ajv implementation error");
      const err = gen.name("err");
      gen.forRange("i", errsCount, names_1.default.errors, (i) => {
        gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
        gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
        gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
        if (it.opts.verbose) {
          gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
          gen.assign((0, codegen_1._)`${err}.data`, data);
        }
      });
    }
    exports.extendErrors = extendErrors;
    function addError(gen, errObj) {
      const err = gen.const("err", errObj);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
      gen.code((0, codegen_1._)`${names_1.default.errors}++`);
    }
    function returnErrors(it, errs) {
      const { gen, validateName, schemaEnv } = it;
      if (schemaEnv.$async) {
        gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
        gen.return(false);
      }
    }
    var E = {
      keyword: new codegen_1.Name("keyword"),
      schemaPath: new codegen_1.Name("schemaPath"),
      // also used in JTD errors
      params: new codegen_1.Name("params"),
      propertyName: new codegen_1.Name("propertyName"),
      message: new codegen_1.Name("message"),
      schema: new codegen_1.Name("schema"),
      parentSchema: new codegen_1.Name("parentSchema")
    };
    function errorObjectCode(cxt, error, errorPaths) {
      const { createErrors } = cxt.it;
      if (createErrors === false)
        return (0, codegen_1._)`{}`;
      return errorObject(cxt, error, errorPaths);
    }
    function errorObject(cxt, error, errorPaths = {}) {
      const { gen, it } = cxt;
      const keyValues = [
        errorInstancePath(it, errorPaths),
        errorSchemaPath(cxt, errorPaths)
      ];
      extraErrorProps(cxt, error, keyValues);
      return gen.object(...keyValues);
    }
    function errorInstancePath({ errorPath }, { instancePath }) {
      const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
      return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
    }
    function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
      let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
      if (schemaPath) {
        schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
      }
      return [E.schemaPath, schPath];
    }
    function extraErrorProps(cxt, { params, message: message2 }, keyValues) {
      const { keyword, data, schemaValue, it } = cxt;
      const { opts, propertyName, topSchemaRef, schemaPath } = it;
      keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
      if (opts.messages) {
        keyValues.push([E.message, typeof message2 == "function" ? message2(cxt) : message2]);
      }
      if (opts.verbose) {
        keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
      }
      if (propertyName)
        keyValues.push([E.propertyName, propertyName]);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/boolSchema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
    var errors_1 = require_errors2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var boolError = {
      message: "boolean schema is false"
    };
    function topBoolOrEmptySchema(it) {
      const { gen, schema, validateName } = it;
      if (schema === false) {
        falseSchemaError(it, false);
      } else if (typeof schema == "object" && schema.$async === true) {
        gen.return(names_1.default.data);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, null);
        gen.return(true);
      }
    }
    exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
    function boolOrEmptySchema(it, valid) {
      const { gen, schema } = it;
      if (schema === false) {
        gen.var(valid, false);
        falseSchemaError(it);
      } else {
        gen.var(valid, true);
      }
    }
    exports.boolOrEmptySchema = boolOrEmptySchema;
    function falseSchemaError(it, overrideAllErrors) {
      const { gen, data } = it;
      const cxt = {
        gen,
        keyword: "false schema",
        data,
        schema: false,
        schemaCode: false,
        schemaValue: false,
        params: {},
        it
      };
      (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/rules.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getRules = exports.isJSONType = void 0;
    var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
    var jsonTypes = new Set(_jsonTypes);
    function isJSONType(x) {
      return typeof x == "string" && jsonTypes.has(x);
    }
    exports.isJSONType = isJSONType;
    function getRules() {
      const groups = {
        number: { type: "number", rules: [] },
        string: { type: "string", rules: [] },
        array: { type: "array", rules: [] },
        object: { type: "object", rules: [] }
      };
      return {
        types: { ...groups, integer: true, boolean: true, null: true },
        rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
        post: { rules: [] },
        all: {},
        keywords: {}
      };
    }
    exports.getRules = getRules;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/applicability.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
    function schemaHasRulesForType({ schema, self }, type) {
      const group = self.RULES.types[type];
      return group && group !== true && shouldUseGroup(schema, group);
    }
    exports.schemaHasRulesForType = schemaHasRulesForType;
    function shouldUseGroup(schema, group) {
      return group.rules.some((rule) => shouldUseRule(schema, rule));
    }
    exports.shouldUseGroup = shouldUseGroup;
    function shouldUseRule(schema, rule) {
      var _a;
      return schema[rule.keyword] !== void 0 || ((_a = rule.definition.implements) === null || _a === void 0 ? void 0 : _a.some((kwd) => schema[kwd] !== void 0));
    }
    exports.shouldUseRule = shouldUseRule;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/dataType.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
    var rules_1 = require_rules();
    var applicability_1 = require_applicability();
    var errors_1 = require_errors2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Correct"] = 0] = "Correct";
      DataType2[DataType2["Wrong"] = 1] = "Wrong";
    })(DataType || (exports.DataType = DataType = {}));
    function getSchemaTypes(schema) {
      const types = getJSONTypes(schema.type);
      const hasNull = types.includes("null");
      if (hasNull) {
        if (schema.nullable === false)
          throw new Error("type: null contradicts nullable: false");
      } else {
        if (!types.length && schema.nullable !== void 0) {
          throw new Error('"nullable" cannot be used without "type"');
        }
        if (schema.nullable === true)
          types.push("null");
      }
      return types;
    }
    exports.getSchemaTypes = getSchemaTypes;
    function getJSONTypes(ts) {
      const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
      if (types.every(rules_1.isJSONType))
        return types;
      throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
    }
    exports.getJSONTypes = getJSONTypes;
    function coerceAndCheckDataType(it, types) {
      const { gen, data, opts } = it;
      const coerceTo = coerceToTypes(types, opts.coerceTypes);
      const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
      if (checkTypes) {
        const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
        gen.if(wrongType, () => {
          if (coerceTo.length)
            coerceData(it, types, coerceTo);
          else
            reportTypeError(it);
        });
      }
      return checkTypes;
    }
    exports.coerceAndCheckDataType = coerceAndCheckDataType;
    var COERCIBLE = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
    function coerceToTypes(types, coerceTypes) {
      return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
    }
    function coerceData(it, types, coerceTo) {
      const { gen, data, opts } = it;
      const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
      const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
      if (opts.coerceTypes === "array") {
        gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
      }
      gen.if((0, codegen_1._)`${coerced} !== undefined`);
      for (const t of coerceTo) {
        if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
          coerceSpecificType(t);
        }
      }
      gen.else();
      reportTypeError(it);
      gen.endIf();
      gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
        gen.assign(data, coerced);
        assignParentData(it, coerced);
      });
      function coerceSpecificType(t) {
        switch (t) {
          case "string":
            gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
            return;
          case "number":
            gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "integer":
            gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "boolean":
            gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
            return;
          case "null":
            gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
            gen.assign(coerced, null);
            return;
          case "array":
            gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
        }
      }
    }
    function assignParentData({ gen, parentData, parentDataProperty }, expr) {
      gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
    }
    function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
      const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
      let cond;
      switch (dataType) {
        case "null":
          return (0, codegen_1._)`${data} ${EQ} null`;
        case "array":
          cond = (0, codegen_1._)`Array.isArray(${data})`;
          break;
        case "object":
          cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
          break;
        case "integer":
          cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
          break;
        case "number":
          cond = numCond();
          break;
        default:
          return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
      }
      return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
      function numCond(_cond = codegen_1.nil) {
        return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
      }
    }
    exports.checkDataType = checkDataType;
    function checkDataTypes(dataTypes, data, strictNums, correct) {
      if (dataTypes.length === 1) {
        return checkDataType(dataTypes[0], data, strictNums, correct);
      }
      let cond;
      const types = (0, util_1.toHash)(dataTypes);
      if (types.array && types.object) {
        const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
        cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
        delete types.null;
        delete types.array;
        delete types.object;
      } else {
        cond = codegen_1.nil;
      }
      if (types.number)
        delete types.integer;
      for (const t in types)
        cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
      return cond;
    }
    exports.checkDataTypes = checkDataTypes;
    var typeError = {
      message: ({ schema }) => `must be ${schema}`,
      params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
    };
    function reportTypeError(it) {
      const cxt = getTypeErrorContext(it);
      (0, errors_1.reportError)(cxt, typeError);
    }
    exports.reportTypeError = reportTypeError;
    function getTypeErrorContext(it) {
      const { gen, data, schema } = it;
      const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
      return {
        gen,
        keyword: "type",
        data,
        schema: schema.type,
        schemaCode,
        schemaValue: schemaCode,
        parentSchema: schema,
        params: {},
        it
      };
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/defaults.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.assignDefaults = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function assignDefaults(it, ty) {
      const { properties, items } = it.schema;
      if (ty === "object" && properties) {
        for (const key in properties) {
          assignDefault(it, key, properties[key].default);
        }
      } else if (ty === "array" && Array.isArray(items)) {
        items.forEach((sch, i) => assignDefault(it, i, sch.default));
      }
    }
    exports.assignDefaults = assignDefaults;
    function assignDefault(it, prop, defaultValue) {
      const { gen, compositeRule, data, opts } = it;
      if (defaultValue === void 0)
        return;
      const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
      if (compositeRule) {
        (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
        return;
      }
      let condition = (0, codegen_1._)`${childData} === undefined`;
      if (opts.useDefaults === "empty") {
        condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
      }
      gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var util_2 = require_util();
    function checkReportMissingProp(cxt, prop) {
      const { gen, data, it } = cxt;
      gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
        cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
        cxt.error();
      });
    }
    exports.checkReportMissingProp = checkReportMissingProp;
    function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
      return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
    }
    exports.checkMissingProp = checkMissingProp;
    function reportMissingProp(cxt, missing) {
      cxt.setParams({ missingProperty: missing }, true);
      cxt.error();
    }
    exports.reportMissingProp = reportMissingProp;
    function hasPropFunc(gen) {
      return gen.scopeValue("func", {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        ref: Object.prototype.hasOwnProperty,
        code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
      });
    }
    exports.hasPropFunc = hasPropFunc;
    function isOwnProperty(gen, data, property) {
      return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
    }
    exports.isOwnProperty = isOwnProperty;
    function propertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
      return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
    }
    exports.propertyInData = propertyInData;
    function noPropertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
      return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
    }
    exports.noPropertyInData = noPropertyInData;
    function allSchemaProperties(schemaMap) {
      return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
    }
    exports.allSchemaProperties = allSchemaProperties;
    function schemaProperties(it, schemaMap) {
      return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
    }
    exports.schemaProperties = schemaProperties;
    function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
      const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
      const valCxt = [
        [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
        [names_1.default.parentData, it.parentData],
        [names_1.default.parentDataProperty, it.parentDataProperty],
        [names_1.default.rootData, names_1.default.rootData]
      ];
      if (it.opts.dynamicRef)
        valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
      const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
      return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
    }
    exports.callValidateCode = callValidateCode;
    var newRegExp = (0, codegen_1._)`new RegExp`;
    function usePattern({ gen, it: { opts } }, pattern) {
      const u = opts.unicodeRegExp ? "u" : "";
      const { regExp } = opts.code;
      const rx = regExp(pattern, u);
      return gen.scopeValue("pattern", {
        key: rx.toString(),
        ref: rx,
        code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
      });
    }
    exports.usePattern = usePattern;
    function validateArray(cxt) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      if (it.allErrors) {
        const validArr = gen.let("valid", true);
        validateItems(() => gen.assign(validArr, false));
        return validArr;
      }
      gen.var(valid, true);
      validateItems(() => gen.break());
      return valid;
      function validateItems(notValid) {
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword,
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          gen.if((0, codegen_1.not)(valid), notValid);
        });
      }
    }
    exports.validateArray = validateArray;
    function validateUnion(cxt) {
      const { gen, schema, keyword, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
      if (alwaysValid && !it.opts.unevaluated)
        return;
      const valid = gen.let("valid", false);
      const schValid = gen.name("_valid");
      gen.block(() => schema.forEach((_sch, i) => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: i,
          compositeRule: true
        }, schValid);
        gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
        const merged = cxt.mergeValidEvaluated(schCxt, schValid);
        if (!merged)
          gen.if((0, codegen_1.not)(valid));
      }));
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    }
    exports.validateUnion = validateUnion;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/keyword.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var code_1 = require_code2();
    var errors_1 = require_errors2();
    function macroKeywordCode(cxt, def) {
      const { gen, keyword, schema, parentSchema, it } = cxt;
      const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
      const schemaRef = useKeyword(gen, keyword, macroSchema);
      if (it.opts.validateSchema !== false)
        it.self.validateSchema(macroSchema, true);
      const valid = gen.name("valid");
      cxt.subschema({
        schema: macroSchema,
        schemaPath: codegen_1.nil,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`,
        topSchemaRef: schemaRef,
        compositeRule: true
      }, valid);
      cxt.pass(valid, () => cxt.error(true));
    }
    exports.macroKeywordCode = macroKeywordCode;
    function funcKeywordCode(cxt, def) {
      var _a;
      const { gen, keyword, schema, parentSchema, $data, it } = cxt;
      checkAsyncKeyword(it, def);
      const validate = !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate;
      const validateRef = useKeyword(gen, keyword, validate);
      const valid = gen.let("valid");
      cxt.block$data(valid, validateKeyword);
      cxt.ok((_a = def.valid) !== null && _a !== void 0 ? _a : valid);
      function validateKeyword() {
        if (def.errors === false) {
          assignValid();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => cxt.error());
        } else {
          const ruleErrs = def.async ? validateAsync() : validateSync();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => addErrs(cxt, ruleErrs));
        }
      }
      function validateAsync() {
        const ruleErrs = gen.let("ruleErrs", null);
        gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
        return ruleErrs;
      }
      function validateSync() {
        const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
        gen.assign(validateErrs, null);
        assignValid(codegen_1.nil);
        return validateErrs;
      }
      function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
        const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
        const passSchema = !("compile" in def && !$data || def.schema === false);
        gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
      }
      function reportErrs(errors) {
        var _a2;
        gen.if((0, codegen_1.not)((_a2 = def.valid) !== null && _a2 !== void 0 ? _a2 : valid), errors);
      }
    }
    exports.funcKeywordCode = funcKeywordCode;
    function modifyData(cxt) {
      const { gen, data, it } = cxt;
      gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
    }
    function addErrs(cxt, errs) {
      const { gen } = cxt;
      gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
        (0, errors_1.extendErrors)(cxt);
      }, () => cxt.error());
    }
    function checkAsyncKeyword({ schemaEnv }, def) {
      if (def.async && !schemaEnv.$async)
        throw new Error("async keyword in sync schema");
    }
    function useKeyword(gen, keyword, result) {
      if (result === void 0)
        throw new Error(`keyword "${keyword}" failed to compile`);
      return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
    }
    function validSchemaType(schema, schemaType, allowUndefined = false) {
      return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
    }
    exports.validSchemaType = validSchemaType;
    function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
      if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) {
        throw new Error("ajv implementation error");
      }
      const deps = def.dependencies;
      if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
        throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
      }
      if (def.validateSchema) {
        const valid = def.validateSchema(schema[keyword]);
        if (!valid) {
          const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
          if (opts.validateSchema === "log")
            self.logger.error(msg);
          else
            throw new Error(msg);
        }
      }
    }
    exports.validateKeywordUsage = validateKeywordUsage;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/subschema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
      if (keyword !== void 0 && schema !== void 0) {
        throw new Error('both "keyword" and "schema" passed, only one allowed');
      }
      if (keyword !== void 0) {
        const sch = it.schema[keyword];
        return schemaProp === void 0 ? {
          schema: sch,
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}`
        } : {
          schema: sch[schemaProp],
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
        };
      }
      if (schema !== void 0) {
        if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) {
          throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
        }
        return {
          schema,
          schemaPath,
          topSchemaRef,
          errSchemaPath
        };
      }
      throw new Error('either "keyword" or "schema" must be passed');
    }
    exports.getSubschema = getSubschema;
    function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
      if (data !== void 0 && dataProp !== void 0) {
        throw new Error('both "data" and "dataProp" passed, only one allowed');
      }
      const { gen } = it;
      if (dataProp !== void 0) {
        const { errorPath, dataPathArr, opts } = it;
        const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
        dataContextProps(nextData);
        subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
        subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
        subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
      }
      if (data !== void 0) {
        const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
        dataContextProps(nextData);
        if (propertyName !== void 0)
          subschema.propertyName = propertyName;
      }
      if (dataTypes)
        subschema.dataTypes = dataTypes;
      function dataContextProps(_nextData) {
        subschema.data = _nextData;
        subschema.dataLevel = it.dataLevel + 1;
        subschema.dataTypes = [];
        it.definedProperties = /* @__PURE__ */ new Set();
        subschema.parentData = it.data;
        subschema.dataNames = [...it.dataNames, _nextData];
      }
    }
    exports.extendSubschemaData = extendSubschemaData;
    function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
      if (compositeRule !== void 0)
        subschema.compositeRule = compositeRule;
      if (createErrors !== void 0)
        subschema.createErrors = createErrors;
      if (allErrors !== void 0)
        subschema.allErrors = allErrors;
      subschema.jtdDiscriminator = jtdDiscriminator;
      subschema.jtdMetadata = jtdMetadata;
    }
    exports.extendSubschemaMode = extendSubschemaMode;
  }
});

// node_modules/.pnpm/fast-deep-equal@3.1.3/node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "node_modules/.pnpm/fast-deep-equal@3.1.3/node_modules/fast-deep-equal/index.js"(exports, module) {
    "use strict";
    module.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// node_modules/.pnpm/json-schema-traverse@1.0.0/node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS({
  "node_modules/.pnpm/json-schema-traverse@1.0.0/node_modules/json-schema-traverse/index.js"(exports, module) {
    "use strict";
    var traverse = module.exports = function(schema, opts, cb) {
      if (typeof opts == "function") {
        cb = opts;
        opts = {};
      }
      cb = opts.cb || cb;
      var pre = typeof cb == "function" ? cb : cb.pre || function() {
      };
      var post = cb.post || function() {
      };
      _traverse(opts, pre, post, schema, "", schema);
    };
    traverse.keywords = {
      additionalItems: true,
      items: true,
      contains: true,
      additionalProperties: true,
      propertyNames: true,
      not: true,
      if: true,
      then: true,
      else: true
    };
    traverse.arrayKeywords = {
      items: true,
      allOf: true,
      anyOf: true,
      oneOf: true
    };
    traverse.propsKeywords = {
      $defs: true,
      definitions: true,
      properties: true,
      patternProperties: true,
      dependencies: true
    };
    traverse.skipKeywords = {
      default: true,
      enum: true,
      const: true,
      required: true,
      maximum: true,
      minimum: true,
      exclusiveMaximum: true,
      exclusiveMinimum: true,
      multipleOf: true,
      maxLength: true,
      minLength: true,
      pattern: true,
      format: true,
      maxItems: true,
      minItems: true,
      uniqueItems: true,
      maxProperties: true,
      minProperties: true
    };
    function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
      if (schema && typeof schema == "object" && !Array.isArray(schema)) {
        pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
        for (var key in schema) {
          var sch = schema[key];
          if (Array.isArray(sch)) {
            if (key in traverse.arrayKeywords) {
              for (var i = 0; i < sch.length; i++)
                _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
            }
          } else if (key in traverse.propsKeywords) {
            if (sch && typeof sch == "object") {
              for (var prop in sch)
                _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
            }
          } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
            _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
          }
        }
        post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      }
    }
    function escapeJsonPtr(str) {
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/resolve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
    var util_1 = require_util();
    var equal = require_fast_deep_equal();
    var traverse = require_json_schema_traverse();
    var SIMPLE_INLINED = /* @__PURE__ */ new Set([
      "type",
      "format",
      "pattern",
      "maxLength",
      "minLength",
      "maxProperties",
      "minProperties",
      "maxItems",
      "minItems",
      "maximum",
      "minimum",
      "uniqueItems",
      "multipleOf",
      "required",
      "enum",
      "const"
    ]);
    function inlineRef(schema, limit = true) {
      if (typeof schema == "boolean")
        return true;
      if (limit === true)
        return !hasRef(schema);
      if (!limit)
        return false;
      return countKeys(schema) <= limit;
    }
    exports.inlineRef = inlineRef;
    var REF_KEYWORDS = /* @__PURE__ */ new Set([
      "$ref",
      "$recursiveRef",
      "$recursiveAnchor",
      "$dynamicRef",
      "$dynamicAnchor"
    ]);
    function hasRef(schema) {
      for (const key in schema) {
        if (REF_KEYWORDS.has(key))
          return true;
        const sch = schema[key];
        if (Array.isArray(sch) && sch.some(hasRef))
          return true;
        if (typeof sch == "object" && hasRef(sch))
          return true;
      }
      return false;
    }
    function countKeys(schema) {
      let count2 = 0;
      for (const key in schema) {
        if (key === "$ref")
          return Infinity;
        count2++;
        if (SIMPLE_INLINED.has(key))
          continue;
        if (typeof schema[key] == "object") {
          (0, util_1.eachItem)(schema[key], (sch) => count2 += countKeys(sch));
        }
        if (count2 === Infinity)
          return Infinity;
      }
      return count2;
    }
    function getFullPath(resolver, id = "", normalize) {
      if (normalize !== false)
        id = normalizeId(id);
      const p = resolver.parse(id);
      return _getFullPath(resolver, p);
    }
    exports.getFullPath = getFullPath;
    function _getFullPath(resolver, p) {
      const serialized = resolver.serialize(p);
      return serialized.split("#")[0] + "#";
    }
    exports._getFullPath = _getFullPath;
    var TRAILING_SLASH_HASH = /#\/?$/;
    function normalizeId(id) {
      return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
    }
    exports.normalizeId = normalizeId;
    function resolveUrl(resolver, baseId, id) {
      id = normalizeId(id);
      return resolver.resolve(baseId, id);
    }
    exports.resolveUrl = resolveUrl;
    var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
    function getSchemaRefs(schema, baseId) {
      if (typeof schema == "boolean")
        return {};
      const { schemaId, uriResolver } = this.opts;
      const schId = normalizeId(schema[schemaId] || baseId);
      const baseIds = { "": schId };
      const pathPrefix = getFullPath(uriResolver, schId, false);
      const localRefs = {};
      const schemaRefs = /* @__PURE__ */ new Set();
      traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
        if (parentJsonPtr === void 0)
          return;
        const fullPath = pathPrefix + jsonPtr;
        let innerBaseId = baseIds[parentJsonPtr];
        if (typeof sch[schemaId] == "string")
          innerBaseId = addRef.call(this, sch[schemaId]);
        addAnchor.call(this, sch.$anchor);
        addAnchor.call(this, sch.$dynamicAnchor);
        baseIds[jsonPtr] = innerBaseId;
        function addRef(ref) {
          const _resolve = this.opts.uriResolver.resolve;
          ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
          if (schemaRefs.has(ref))
            throw ambiguos(ref);
          schemaRefs.add(ref);
          let schOrRef = this.refs[ref];
          if (typeof schOrRef == "string")
            schOrRef = this.refs[schOrRef];
          if (typeof schOrRef == "object") {
            checkAmbiguosRef(sch, schOrRef.schema, ref);
          } else if (ref !== normalizeId(fullPath)) {
            if (ref[0] === "#") {
              checkAmbiguosRef(sch, localRefs[ref], ref);
              localRefs[ref] = sch;
            } else {
              this.refs[ref] = fullPath;
            }
          }
          return ref;
        }
        function addAnchor(anchor) {
          if (typeof anchor == "string") {
            if (!ANCHOR.test(anchor))
              throw new Error(`invalid anchor "${anchor}"`);
            addRef.call(this, `#${anchor}`);
          }
        }
      });
      return localRefs;
      function checkAmbiguosRef(sch1, sch2, ref) {
        if (sch2 !== void 0 && !equal(sch1, sch2))
          throw ambiguos(ref);
      }
      function ambiguos(ref) {
        return new Error(`reference "${ref}" resolves to more than one schema`);
      }
    }
    exports.getSchemaRefs = getSchemaRefs;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
    var boolSchema_1 = require_boolSchema();
    var dataType_1 = require_dataType();
    var applicability_1 = require_applicability();
    var dataType_2 = require_dataType();
    var defaults_1 = require_defaults();
    var keyword_1 = require_keyword();
    var subschema_1 = require_subschema();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var errors_1 = require_errors2();
    function validateFunctionCode(it) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          topSchemaObjCode(it);
          return;
        }
      }
      validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
    }
    exports.validateFunctionCode = validateFunctionCode;
    function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
      if (opts.code.es5) {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
          gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
          destructureValCxtES5(gen, opts);
          gen.code(body);
        });
      } else {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
      }
    }
    function destructureValCxt(opts) {
      return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
    }
    function destructureValCxtES5(gen, opts) {
      gen.if(names_1.default.valCxt, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
        gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
      }, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.rootData, names_1.default.data);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
      });
    }
    function topSchemaObjCode(it) {
      const { schema, opts, gen } = it;
      validateFunction(it, () => {
        if (opts.$comment && schema.$comment)
          commentKeyword(it);
        checkNoDefault(it);
        gen.let(names_1.default.vErrors, null);
        gen.let(names_1.default.errors, 0);
        if (opts.unevaluated)
          resetEvaluated(it);
        typeAndKeywords(it);
        returnResults(it);
      });
      return;
    }
    function resetEvaluated(it) {
      const { gen, validateName } = it;
      it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
    }
    function funcSourceUrl(schema, opts) {
      const schId = typeof schema == "object" && schema[opts.schemaId];
      return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
    }
    function subschemaCode(it, valid) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          subSchemaObjCode(it, valid);
          return;
        }
      }
      (0, boolSchema_1.boolOrEmptySchema)(it, valid);
    }
    function schemaCxtHasRules({ schema, self }) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (self.RULES.all[key])
          return true;
      return false;
    }
    function isSchemaObj(it) {
      return typeof it.schema != "boolean";
    }
    function subSchemaObjCode(it, valid) {
      const { schema, gen, opts } = it;
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      updateContext(it);
      checkAsyncSchema(it);
      const errsCount = gen.const("_errs", names_1.default.errors);
      typeAndKeywords(it, errsCount);
      gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
    }
    function checkKeywords(it) {
      (0, util_1.checkUnknownRules)(it);
      checkRefsAndKeywords(it);
    }
    function typeAndKeywords(it, errsCount) {
      if (it.opts.jtd)
        return schemaKeywords(it, [], false, errsCount);
      const types = (0, dataType_1.getSchemaTypes)(it.schema);
      const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
      schemaKeywords(it, types, !checkedTypes, errsCount);
    }
    function checkRefsAndKeywords(it) {
      const { schema, errSchemaPath, opts, self } = it;
      if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
        self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
      }
    }
    function checkNoDefault(it) {
      const { schema, opts } = it;
      if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) {
        (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
      }
    }
    function updateContext(it) {
      const schId = it.schema[it.opts.schemaId];
      if (schId)
        it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
    }
    function checkAsyncSchema(it) {
      if (it.schema.$async && !it.schemaEnv.$async)
        throw new Error("async schema in sync schema");
    }
    function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
      const msg = schema.$comment;
      if (opts.$comment === true) {
        gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
      } else if (typeof opts.$comment == "function") {
        const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
        const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
        gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
      }
    }
    function returnResults(it) {
      const { gen, schemaEnv, validateName, ValidationError, opts } = it;
      if (schemaEnv.$async) {
        gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
        if (opts.unevaluated)
          assignEvaluated(it);
        gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
      }
    }
    function assignEvaluated({ gen, evaluated, props, items }) {
      if (props instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.props`, props);
      if (items instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.items`, items);
    }
    function schemaKeywords(it, types, typeErrors, errsCount) {
      const { gen, schema, data, allErrors, opts, self } = it;
      const { RULES } = self;
      if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
        gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
        return;
      }
      if (!opts.jtd)
        checkStrictTypes(it, types);
      gen.block(() => {
        for (const group of RULES.rules)
          groupKeywords(group);
        groupKeywords(RULES.post);
      });
      function groupKeywords(group) {
        if (!(0, applicability_1.shouldUseGroup)(schema, group))
          return;
        if (group.type) {
          gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
          iterateKeywords(it, group);
          if (types.length === 1 && types[0] === group.type && typeErrors) {
            gen.else();
            (0, dataType_2.reportTypeError)(it);
          }
          gen.endIf();
        } else {
          iterateKeywords(it, group);
        }
        if (!allErrors)
          gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
      }
    }
    function iterateKeywords(it, group) {
      const { gen, schema, opts: { useDefaults } } = it;
      if (useDefaults)
        (0, defaults_1.assignDefaults)(it, group.type);
      gen.block(() => {
        for (const rule of group.rules) {
          if ((0, applicability_1.shouldUseRule)(schema, rule)) {
            keywordCode(it, rule.keyword, rule.definition, group.type);
          }
        }
      });
    }
    function checkStrictTypes(it, types) {
      if (it.schemaEnv.meta || !it.opts.strictTypes)
        return;
      checkContextTypes(it, types);
      if (!it.opts.allowUnionTypes)
        checkMultipleTypes(it, types);
      checkKeywordTypes(it, it.dataTypes);
    }
    function checkContextTypes(it, types) {
      if (!types.length)
        return;
      if (!it.dataTypes.length) {
        it.dataTypes = types;
        return;
      }
      types.forEach((t) => {
        if (!includesType(it.dataTypes, t)) {
          strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
        }
      });
      narrowSchemaTypes(it, types);
    }
    function checkMultipleTypes(it, ts) {
      if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
        strictTypesError(it, "use allowUnionTypes to allow union type keyword");
      }
    }
    function checkKeywordTypes(it, ts) {
      const rules = it.self.RULES.all;
      for (const keyword in rules) {
        const rule = rules[keyword];
        if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
          const { type } = rule.definition;
          if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
            strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
          }
        }
      }
    }
    function hasApplicableType(schTs, kwdT) {
      return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
    }
    function includesType(ts, t) {
      return ts.includes(t) || t === "integer" && ts.includes("number");
    }
    function narrowSchemaTypes(it, withTypes) {
      const ts = [];
      for (const t of it.dataTypes) {
        if (includesType(withTypes, t))
          ts.push(t);
        else if (withTypes.includes("integer") && t === "number")
          ts.push("integer");
      }
      it.dataTypes = ts;
    }
    function strictTypesError(it, msg) {
      const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
      msg += ` at "${schemaPath}" (strictTypes)`;
      (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
    }
    var KeywordCxt = class {
      constructor(it, def, keyword) {
        (0, keyword_1.validateKeywordUsage)(it, def, keyword);
        this.gen = it.gen;
        this.allErrors = it.allErrors;
        this.keyword = keyword;
        this.data = it.data;
        this.schema = it.schema[keyword];
        this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
        this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
        this.schemaType = def.schemaType;
        this.parentSchema = it.schema;
        this.params = {};
        this.it = it;
        this.def = def;
        if (this.$data) {
          this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
        } else {
          this.schemaCode = this.schemaValue;
          if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) {
            throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
          }
        }
        if ("code" in def ? def.trackErrors : def.errors !== false) {
          this.errsCount = it.gen.const("_errs", names_1.default.errors);
        }
      }
      result(condition, successAction, failAction) {
        this.failResult((0, codegen_1.not)(condition), successAction, failAction);
      }
      failResult(condition, successAction, failAction) {
        this.gen.if(condition);
        if (failAction)
          failAction();
        else
          this.error();
        if (successAction) {
          this.gen.else();
          successAction();
          if (this.allErrors)
            this.gen.endIf();
        } else {
          if (this.allErrors)
            this.gen.endIf();
          else
            this.gen.else();
        }
      }
      pass(condition, failAction) {
        this.failResult((0, codegen_1.not)(condition), void 0, failAction);
      }
      fail(condition) {
        if (condition === void 0) {
          this.error();
          if (!this.allErrors)
            this.gen.if(false);
          return;
        }
        this.gen.if(condition);
        this.error();
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
      fail$data(condition) {
        if (!this.$data)
          return this.fail(condition);
        const { schemaCode } = this;
        this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
      }
      error(append, errorParams, errorPaths) {
        if (errorParams) {
          this.setParams(errorParams);
          this._error(append, errorPaths);
          this.setParams({});
          return;
        }
        this._error(append, errorPaths);
      }
      _error(append, errorPaths) {
        ;
        (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
      }
      $dataError() {
        (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
      }
      reset() {
        if (this.errsCount === void 0)
          throw new Error('add "trackErrors" to keyword definition');
        (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
      }
      ok(cond) {
        if (!this.allErrors)
          this.gen.if(cond);
      }
      setParams(obj, assign) {
        if (assign)
          Object.assign(this.params, obj);
        else
          this.params = obj;
      }
      block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
        this.gen.block(() => {
          this.check$data(valid, $dataValid);
          codeBlock();
        });
      }
      check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
        if (!this.$data)
          return;
        const { gen, schemaCode, schemaType, def } = this;
        gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
        if (valid !== codegen_1.nil)
          gen.assign(valid, true);
        if (schemaType.length || def.validateSchema) {
          gen.elseIf(this.invalid$data());
          this.$dataError();
          if (valid !== codegen_1.nil)
            gen.assign(valid, false);
        }
        gen.else();
      }
      invalid$data() {
        const { gen, schemaCode, schemaType, def, it } = this;
        return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
        function wrong$DataType() {
          if (schemaType.length) {
            if (!(schemaCode instanceof codegen_1.Name))
              throw new Error("ajv implementation error");
            const st = Array.isArray(schemaType) ? schemaType : [schemaType];
            return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
          }
          return codegen_1.nil;
        }
        function invalid$DataSchema() {
          if (def.validateSchema) {
            const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
            return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
          }
          return codegen_1.nil;
        }
      }
      subschema(appl, valid) {
        const subschema = (0, subschema_1.getSubschema)(this.it, appl);
        (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
        (0, subschema_1.extendSubschemaMode)(subschema, appl);
        const nextContext = { ...this.it, ...subschema, items: void 0, props: void 0 };
        subschemaCode(nextContext, valid);
        return nextContext;
      }
      mergeEvaluated(schemaCxt, toName) {
        const { it, gen } = this;
        if (!it.opts.unevaluated)
          return;
        if (it.props !== true && schemaCxt.props !== void 0) {
          it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
        }
        if (it.items !== true && schemaCxt.items !== void 0) {
          it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
        }
      }
      mergeValidEvaluated(schemaCxt, valid) {
        const { it, gen } = this;
        if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
          gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
          return true;
        }
      }
    };
    exports.KeywordCxt = KeywordCxt;
    function keywordCode(it, keyword, def, ruleType) {
      const cxt = new KeywordCxt(it, def, keyword);
      if ("code" in def) {
        def.code(cxt, ruleType);
      } else if (cxt.$data && def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      } else if ("macro" in def) {
        (0, keyword_1.macroKeywordCode)(cxt, def);
      } else if (def.compile || def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      }
    }
    var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
    var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
    function getData($data, { dataLevel, dataNames, dataPathArr }) {
      let jsonPointer;
      let data;
      if ($data === "")
        return names_1.default.rootData;
      if ($data[0] === "/") {
        if (!JSON_POINTER.test($data))
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        jsonPointer = $data;
        data = names_1.default.rootData;
      } else {
        const matches = RELATIVE_JSON_POINTER.exec($data);
        if (!matches)
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        const up = +matches[1];
        jsonPointer = matches[2];
        if (jsonPointer === "#") {
          if (up >= dataLevel)
            throw new Error(errorMsg("property/index", up));
          return dataPathArr[dataLevel - up];
        }
        if (up > dataLevel)
          throw new Error(errorMsg("data", up));
        data = dataNames[dataLevel - up];
        if (!jsonPointer)
          return data;
      }
      let expr = data;
      const segments = jsonPointer.split("/");
      for (const segment of segments) {
        if (segment) {
          data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
          expr = (0, codegen_1._)`${expr} && ${data}`;
        }
      }
      return expr;
      function errorMsg(pointerType, up) {
        return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
      }
    }
    exports.getData = getData;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/validation_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var ValidationError = class extends Error {
      constructor(errors) {
        super("validation failed");
        this.errors = errors;
        this.ajv = this.validation = true;
      }
    };
    exports.default = ValidationError;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/ref_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var resolve_1 = require_resolve();
    var MissingRefError = class extends Error {
      constructor(resolver, baseId, ref, msg) {
        super(msg || `can't resolve reference ${ref} from id ${baseId}`);
        this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
        this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
      }
    };
    exports.default = MissingRefError;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
    var codegen_1 = require_codegen();
    var validation_error_1 = require_validation_error();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var validate_1 = require_validate();
    var SchemaEnv = class {
      constructor(env) {
        var _a;
        this.refs = {};
        this.dynamicAnchors = {};
        let schema;
        if (typeof env.schema == "object")
          schema = env.schema;
        this.schema = env.schema;
        this.schemaId = env.schemaId;
        this.root = env.root || this;
        this.baseId = (_a = env.baseId) !== null && _a !== void 0 ? _a : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
        this.schemaPath = env.schemaPath;
        this.localRefs = env.localRefs;
        this.meta = env.meta;
        this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
        this.refs = {};
      }
    };
    exports.SchemaEnv = SchemaEnv;
    function compileSchema(sch) {
      const _sch = getCompilingSchema.call(this, sch);
      if (_sch)
        return _sch;
      const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
      const { es5, lines } = this.opts.code;
      const { ownProperties } = this.opts;
      const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
      let _ValidationError;
      if (sch.$async) {
        _ValidationError = gen.scopeValue("Error", {
          ref: validation_error_1.default,
          code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
        });
      }
      const validateName = gen.scopeName("validate");
      sch.validateName = validateName;
      const schemaCxt = {
        gen,
        allErrors: this.opts.allErrors,
        data: names_1.default.data,
        parentData: names_1.default.parentData,
        parentDataProperty: names_1.default.parentDataProperty,
        dataNames: [names_1.default.data],
        dataPathArr: [codegen_1.nil],
        // TODO can its length be used as dataLevel if nil is removed?
        dataLevel: 0,
        dataTypes: [],
        definedProperties: /* @__PURE__ */ new Set(),
        topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
        validateName,
        ValidationError: _ValidationError,
        schema: sch.schema,
        schemaEnv: sch,
        rootId,
        baseId: sch.baseId || rootId,
        schemaPath: codegen_1.nil,
        errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
        errorPath: (0, codegen_1._)`""`,
        opts: this.opts,
        self: this
      };
      let sourceCode;
      try {
        this._compilations.add(sch);
        (0, validate_1.validateFunctionCode)(schemaCxt);
        gen.optimize(this.opts.code.optimize);
        const validateCode = gen.toString();
        sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
        if (this.opts.code.process)
          sourceCode = this.opts.code.process(sourceCode, sch);
        const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
        const validate = makeValidate(this, this.scope.get());
        this.scope.value(validateName, { ref: validate });
        validate.errors = null;
        validate.schema = sch.schema;
        validate.schemaEnv = sch;
        if (sch.$async)
          validate.$async = true;
        if (this.opts.code.source === true) {
          validate.source = { validateName, validateCode, scopeValues: gen._values };
        }
        if (this.opts.unevaluated) {
          const { props, items } = schemaCxt;
          validate.evaluated = {
            props: props instanceof codegen_1.Name ? void 0 : props,
            items: items instanceof codegen_1.Name ? void 0 : items,
            dynamicProps: props instanceof codegen_1.Name,
            dynamicItems: items instanceof codegen_1.Name
          };
          if (validate.source)
            validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
        }
        sch.validate = validate;
        return sch;
      } catch (e) {
        delete sch.validate;
        delete sch.validateName;
        if (sourceCode)
          this.logger.error("Error compiling schema, function code:", sourceCode);
        throw e;
      } finally {
        this._compilations.delete(sch);
      }
    }
    exports.compileSchema = compileSchema;
    function resolveRef(root, baseId, ref) {
      var _a;
      ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
      const schOrFunc = root.refs[ref];
      if (schOrFunc)
        return schOrFunc;
      let _sch = resolve.call(this, root, ref);
      if (_sch === void 0) {
        const schema = (_a = root.localRefs) === null || _a === void 0 ? void 0 : _a[ref];
        const { schemaId } = this.opts;
        if (schema)
          _sch = new SchemaEnv({ schema, schemaId, root, baseId });
      }
      if (_sch === void 0)
        return;
      return root.refs[ref] = inlineOrCompile.call(this, _sch);
    }
    exports.resolveRef = resolveRef;
    function inlineOrCompile(sch) {
      if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
        return sch.schema;
      return sch.validate ? sch : compileSchema.call(this, sch);
    }
    function getCompilingSchema(schEnv) {
      for (const sch of this._compilations) {
        if (sameSchemaEnv(sch, schEnv))
          return sch;
      }
    }
    exports.getCompilingSchema = getCompilingSchema;
    function sameSchemaEnv(s1, s2) {
      return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
    }
    function resolve(root, ref) {
      let sch;
      while (typeof (sch = this.refs[ref]) == "string")
        ref = sch;
      return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
    }
    function resolveSchema(root, ref) {
      const p = this.opts.uriResolver.parse(ref);
      const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
      let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
      if (Object.keys(root.schema).length > 0 && refPath === baseId) {
        return getJsonPointer.call(this, p, root);
      }
      const id = (0, resolve_1.normalizeId)(refPath);
      const schOrRef = this.refs[id] || this.schemas[id];
      if (typeof schOrRef == "string") {
        const sch = resolveSchema.call(this, root, schOrRef);
        if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object")
          return;
        return getJsonPointer.call(this, p, sch);
      }
      if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object")
        return;
      if (!schOrRef.validate)
        compileSchema.call(this, schOrRef);
      if (id === (0, resolve_1.normalizeId)(ref)) {
        const { schema } = schOrRef;
        const { schemaId } = this.opts;
        const schId = schema[schemaId];
        if (schId)
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        return new SchemaEnv({ schema, schemaId, root, baseId });
      }
      return getJsonPointer.call(this, p, schOrRef);
    }
    exports.resolveSchema = resolveSchema;
    var PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
      "properties",
      "patternProperties",
      "enum",
      "dependencies",
      "definitions"
    ]);
    function getJsonPointer(parsedRef, { baseId, schema, root }) {
      var _a;
      if (((_a = parsedRef.fragment) === null || _a === void 0 ? void 0 : _a[0]) !== "/")
        return;
      for (const part of parsedRef.fragment.slice(1).split("/")) {
        if (typeof schema === "boolean")
          return;
        const partSchema = schema[(0, util_1.unescapeFragment)(part)];
        if (partSchema === void 0)
          return;
        schema = partSchema;
        const schId = typeof schema === "object" && schema[this.opts.schemaId];
        if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        }
      }
      let env;
      if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
        const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
        env = resolveSchema.call(this, root, $ref);
      }
      const { schemaId } = this.opts;
      env = env || new SchemaEnv({ schema, schemaId, root, baseId });
      if (env.schema !== env.root.schema)
        return env;
      return void 0;
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/data.json
var require_data = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/data.json"(exports, module) {
    module.exports = {
      $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
      description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
      type: "object",
      required: ["$data"],
      properties: {
        $data: {
          type: "string",
          anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
        }
      },
      additionalProperties: false
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/lib/utils.js"(exports, module) {
    "use strict";
    var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
    var isPort = RegExp.prototype.test.bind(/^\d*$/u);
    var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
    var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
    var isPathCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/u);
    var isQueryFragmentCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/u);
    var isUserinfoCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:]$/u);
    var BYTE_HEX = new Array(256);
    {
      const HEX_DIGITS = "0123456789ABCDEF";
      for (let i = 0; i < 256; i++) {
        BYTE_HEX[i] = "%" + HEX_DIGITS[i >> 4] + HEX_DIGITS[i & 15];
      }
    }
    function percentEncodeNonAscii(cp) {
      if (cp < 2048) {
        return BYTE_HEX[192 | cp >> 6] + BYTE_HEX[128 | cp & 63];
      }
      if (cp < 65536) {
        return BYTE_HEX[224 | cp >> 12] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
      }
      return BYTE_HEX[240 | cp >> 18] + BYTE_HEX[128 | cp >> 12 & 63] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
    }
    function stringArrayToHexStripped(input) {
      let acc = "";
      let code = 0;
      let i = 0;
      for (i = 0; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (code === 48) {
          continue;
        }
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
        break;
      }
      for (i += 1; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
      }
      return acc;
    }
    var isHextet = RegExp.prototype.test.bind(/^[\dA-Fa-f]{1,4}$/);
    var isIPvFuture = RegExp.prototype.test.bind(/^[vV][\dA-Fa-f]+\.[A-Za-z\d\-._~!$&'()*+,;=:]+$/);
    var isZoneCharacter = RegExp.prototype.test.bind(/^[A-Za-z\d\-._~]$/);
    var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
    function isZoneIdentifier(zone) {
      if (zone.length === 0) return false;
      for (let i = 0; i < zone.length; i++) {
        if (isZoneCharacter(zone[i])) continue;
        if (zone[i] === "%" && i + 2 < zone.length && isHexPair(zone.slice(i + 1, i + 3))) {
          i += 2;
          continue;
        }
        return false;
      }
      return true;
    }
    function compressIPv6ZeroRun(hextets) {
      let bestStart = -1;
      let bestLength = 0;
      let runStart = -1;
      let runLength = 0;
      for (let i = 0; i < hextets.length; i++) {
        if (hextets[i] === "0") {
          if (runStart === -1) runStart = i;
          runLength++;
          if (runLength > bestLength) {
            bestLength = runLength;
            bestStart = runStart;
          }
        } else {
          runStart = -1;
          runLength = 0;
        }
      }
      if (bestLength < 2) return hextets.join(":");
      const head = hextets.slice(0, bestStart).join(":");
      const tail = hextets.slice(bestStart + bestLength).join(":");
      return head + "::" + tail;
    }
    function normalizeIPv6Address(input) {
      const compression = input.indexOf("::");
      if (compression !== -1 && input.indexOf("::", compression + 1) !== -1) return void 0;
      const left = compression === -1 ? input.split(":") : input.slice(0, compression).split(":");
      const right = compression === -1 ? [] : input.slice(compression + 2).split(":");
      if (compression !== -1) {
        if (left.length === 1 && left[0] === "") left.length = 0;
        if (right.length === 1 && right[0] === "") right.length = 0;
      }
      const parts = left.concat(right);
      let hextetCount = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "") return void 0;
        if (part.indexOf(".") !== -1) {
          if (i !== parts.length - 1 || compression !== -1 && right.length === 0 || !isIPv4(part)) return void 0;
          hextetCount += 2;
          continue;
        }
        if (!isHextet(part)) return void 0;
        parts[i] = parseInt(part, 16).toString(16);
        hextetCount++;
      }
      if (compression === -1) {
        if (hextetCount !== 8) return void 0;
        return compressIPv6ZeroRun(parts);
      }
      if (hextetCount >= 8) return void 0;
      const expanded = parts.slice(0, left.length);
      for (let i = hextetCount; i < 8; i++) expanded.push("0");
      for (let i = left.length; i < parts.length; i++) expanded.push(parts[i]);
      return compressIPv6ZeroRun(expanded);
    }
    function normalizeIPv6(host) {
      const bracketed = host[0] === "[" && host[host.length - 1] === "]";
      const hasBracket = host[0] === "[" || host[host.length - 1] === "]";
      if (hasBracket && !bracketed) return { host, isIPV6: false, error: true };
      let input = bracketed ? host.slice(1, -1) : host;
      if (bracketed && isIPvFuture(input)) {
        input = input.toLowerCase();
        return { host: `[${input}]`, escapedHost: input, isIPV6: false, isIPVFuture: true };
      }
      if (findToken(input, ":") < 2) {
        return { host, isIPV6: false, error: bracketed };
      }
      let zoneIdentifier = "";
      const zoneSeparator = input.indexOf("%");
      if (zoneSeparator !== -1) {
        const separatorLength = input.slice(zoneSeparator, zoneSeparator + 3).toLowerCase() === "%25" ? 3 : 1;
        zoneIdentifier = input.slice(zoneSeparator + separatorLength);
        if (!isZoneIdentifier(zoneIdentifier)) return { host, isIPV6: false, error: true };
        input = input.slice(0, zoneSeparator);
      }
      const address = normalizeIPv6Address(input);
      if (address === void 0) return { host, isIPV6: false, error: true };
      return {
        host: address + (zoneIdentifier ? "%" + zoneIdentifier : ""),
        escapedHost: address + (zoneIdentifier ? "%25" + zoneIdentifier : ""),
        isIPV6: true
      };
    }
    function findToken(str, token) {
      let ind = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === token) ind++;
      }
      return ind;
    }
    function removeDotSegments(path) {
      let input = path;
      const output = [];
      let nextSlash = -1;
      let len = 0;
      while (len = input.length) {
        if (len === 1) {
          if (input === ".") {
            break;
          } else if (input === "/") {
            output.push("/");
            break;
          } else {
            output.push(input);
            break;
          }
        } else if (len === 2) {
          if (input[0] === ".") {
            if (input[1] === ".") {
              break;
            } else if (input[1] === "/") {
              input = input.slice(2);
              continue;
            }
          } else if (input[0] === "/") {
            if (input[1] === "." || input[1] === "/") {
              output.push("/");
              break;
            }
          }
        } else if (len === 3) {
          if (input === "/..") {
            if (output.length !== 0) {
              output.pop();
            }
            output.push("/");
            break;
          }
        }
        if (input[0] === ".") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(3);
              continue;
            }
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(2);
              continue;
            } else if (input[2] === ".") {
              if (input[3] === "/") {
                input = input.slice(3);
                if (output.length !== 0) {
                  output.pop();
                }
                continue;
              }
            }
          }
        }
        if ((nextSlash = input.indexOf("/", 1)) === -1) {
          output.push(input);
          break;
        } else {
          output.push(input.slice(0, nextSlash));
          input = input.slice(nextSlash);
        }
      }
      return output.join("");
    }
    var HOST_DELIMS = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" };
    var HOST_DELIM_RE = /[@/?#:]/g;
    var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
    function reescapeHostDelimiters(host, isIP2) {
      const re = isIP2 ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
      re.lastIndex = 0;
      return host.replace(re, (ch) => HOST_DELIMS[ch]);
    }
    function normalizePercentEncoding(input, decodeUnreserved = false) {
      if (input.indexOf("%") === -1) {
        return input;
      }
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decodeUnreserved && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        output += input[i];
      }
      return output;
    }
    function normalizePathEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decoded !== "." && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isPathCharacter(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function serializePathEncoding(input, pathNoScheme = false) {
      let output = "";
      let firstSegment = pathNoScheme && input[0] !== "/";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        if (ch === "/") {
          firstSegment = false;
        }
        if (isPathCharacter(ch) && (ch !== ":" || !firstSegment)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function encodeComponent(input, isAllowed) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        if (isAllowed(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function encodeUserinfo(input) {
      return encodeComponent(input, isUserinfoCharacter);
    }
    function encodeQuery(input) {
      return encodeComponent(input, isQueryFragmentCharacter);
    }
    function encodeFragment(input) {
      return encodeComponent(input, isQueryFragmentCharacter);
    }
    function isEscapeSafe(cp) {
      return cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp === 42 || cp === 43 || cp === 45 || cp === 46 || cp === 47 || cp === 64 || cp === 95;
    }
    function normalizeQueryFragmentEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isQueryFragmentCharacter(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function escapePreservingEscapes(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        output += escape(input[i]);
      }
      return output;
    }
    function recomposeAuthority(component) {
      const uriTokens = [];
      if (component.userinfo !== void 0) {
        uriTokens.push(encodeUserinfo(component.userinfo));
        uriTokens.push("@");
      }
      if (component.host !== void 0) {
        let host = component.host;
        if (!isIPv4(host)) {
          let ipV6res = normalizeIPv6(host);
          if (ipV6res.isIPV6 !== true && ipV6res.isIPVFuture !== true) {
            host = normalizePercentEncoding(host, true);
            ipV6res = normalizeIPv6(host);
          }
          if (ipV6res.isIPV6 === true || ipV6res.isIPVFuture === true) {
            host = `[${ipV6res.escapedHost}]`;
          } else {
            host = reescapeHostDelimiters(host, false);
          }
        }
        uriTokens.push(host);
      }
      if (typeof component.port === "number" || typeof component.port === "string") {
        const port = String(component.port);
        if (!isPort(port)) {
          throw new TypeError("URI port is malformed.");
        }
        uriTokens.push(":");
        uriTokens.push(port);
      }
      return uriTokens.length ? uriTokens.join("") : void 0;
    }
    module.exports = {
      nonSimpleDomain,
      recomposeAuthority,
      reescapeHostDelimiters,
      normalizePercentEncoding,
      normalizePathEncoding,
      serializePathEncoding,
      normalizeQueryFragmentEncoding,
      encodeUserinfo,
      encodeQuery,
      encodeFragment,
      escapePreservingEscapes,
      removeDotSegments,
      isIPv4,
      isUUID,
      normalizeIPv6,
      stringArrayToHexStripped
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/lib/schemes.js"(exports, module) {
    "use strict";
    var { isUUID } = require_utils();
    var URN_REG = /^([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-./:;=@]|%[\da-f]{2})+)$/iu;
    var supportedSchemeNames = (
      /** @type {const} */
      [
        "http",
        "https",
        "ws",
        "wss",
        "urn",
        "urn:uuid"
      ]
    );
    function isValidSchemeName(name) {
      return supportedSchemeNames.indexOf(
        /** @type {*} */
        name
      ) !== -1;
    }
    function wsIsSecure(wsComponent) {
      if (wsComponent.secure === true) {
        return true;
      } else if (wsComponent.secure === false) {
        return false;
      } else if (wsComponent.scheme) {
        return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
      } else {
        return false;
      }
    }
    function httpParse(component) {
      if (!component.host) {
        component.error = component.error || "HTTP URIs must have a host.";
      }
      return component;
    }
    function httpSerialize(component) {
      const secure = String(component.scheme).toLowerCase() === "https";
      if (component.port === (secure ? 443 : 80) || component.port === "") {
        component.port = void 0;
      }
      if (!component.path) {
        component.path = "/";
      }
      return component;
    }
    function wsParse(wsComponent) {
      wsComponent.secure = wsIsSecure(wsComponent);
      wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
      wsComponent.path = void 0;
      wsComponent.query = void 0;
      return wsComponent;
    }
    function wsSerialize(wsComponent) {
      if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
        wsComponent.port = void 0;
      }
      if (typeof wsComponent.secure === "boolean") {
        wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
        wsComponent.secure = void 0;
      }
      if (wsComponent.resourceName) {
        const queryIndex = wsComponent.resourceName.indexOf("?");
        const path = queryIndex === -1 ? wsComponent.resourceName : wsComponent.resourceName.slice(0, queryIndex);
        wsComponent.path = path && path !== "/" ? path : void 0;
        wsComponent.query = queryIndex === -1 ? void 0 : wsComponent.resourceName.slice(queryIndex + 1);
        wsComponent.resourceName = void 0;
      }
      wsComponent.fragment = void 0;
      return wsComponent;
    }
    function urnParse(urnComponent, options) {
      if (!urnComponent.path) {
        urnComponent.error = "URN can not be parsed";
        return urnComponent;
      }
      const matches = urnComponent.path.match(URN_REG);
      if (matches && matches[0] === urnComponent.path) {
        const scheme = options.scheme || urnComponent.scheme || "urn";
        urnComponent.nid = matches[1].toLowerCase();
        urnComponent.nss = matches[2];
        const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
        const schemeHandler = getSchemeHandler(urnScheme);
        urnComponent.path = void 0;
        if (schemeHandler) {
          urnComponent = schemeHandler.parse(urnComponent, options);
        }
      } else {
        urnComponent.error = urnComponent.error || "URN can not be parsed.";
      }
      return urnComponent;
    }
    function urnSerialize(urnComponent, options) {
      if (urnComponent.nid === void 0) {
        throw new Error("URN without nid cannot be serialized");
      }
      const scheme = options.scheme || urnComponent.scheme || "urn";
      const nid = urnComponent.nid.toLowerCase();
      const urnScheme = `${scheme}:${options.nid || nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      if (schemeHandler) {
        urnComponent = schemeHandler.serialize(urnComponent, options);
      }
      const uriComponent = urnComponent;
      const nss = urnComponent.nss;
      uriComponent.path = `${nid || options.nid}:${nss}`;
      options.skipEscape = true;
      return uriComponent;
    }
    function urnuuidParse(urnComponent, options) {
      const uuidComponent = urnComponent;
      uuidComponent.uuid = uuidComponent.nss;
      uuidComponent.nss = void 0;
      if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
        uuidComponent.error = uuidComponent.error || "UUID is not valid.";
      }
      return uuidComponent;
    }
    function urnuuidSerialize(uuidComponent) {
      const urnComponent = uuidComponent;
      urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
      return urnComponent;
    }
    var http = (
      /** @type {SchemeHandler} */
      {
        scheme: "http",
        domainHost: true,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var https = (
      /** @type {SchemeHandler} */
      {
        scheme: "https",
        domainHost: http.domainHost,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var ws = (
      /** @type {SchemeHandler} */
      {
        scheme: "ws",
        domainHost: true,
        parse: wsParse,
        serialize: wsSerialize
      }
    );
    var wss = (
      /** @type {SchemeHandler} */
      {
        scheme: "wss",
        domainHost: ws.domainHost,
        parse: ws.parse,
        serialize: ws.serialize
      }
    );
    var urn = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn",
        parse: urnParse,
        serialize: urnSerialize,
        skipNormalize: true
      }
    );
    var urnuuid = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn:uuid",
        parse: urnuuidParse,
        serialize: urnuuidSerialize,
        skipNormalize: true
      }
    );
    var SCHEMES = (
      /** @type {Record<SchemeName, SchemeHandler>} */
      {
        http,
        https,
        ws,
        wss,
        urn,
        "urn:uuid": urnuuid
      }
    );
    Object.setPrototypeOf(SCHEMES, null);
    function getSchemeHandler(scheme) {
      return scheme && (SCHEMES[
        /** @type {SchemeName} */
        scheme
      ] || SCHEMES[
        /** @type {SchemeName} */
        scheme.toLowerCase()
      ]) || void 0;
    }
    module.exports = {
      wsIsSecure,
      SCHEMES,
      isValidSchemeName,
      getSchemeHandler
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/index.js
var require_fast_uri = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.8/node_modules/fast-uri/index.js"(exports, module) {
    "use strict";
    var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, serializePathEncoding, normalizeQueryFragmentEncoding, encodeQuery, encodeFragment, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
    var { SCHEMES, getSchemeHandler } = require_schemes();
    var VALID_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;
    var MALFORMED_SCHEME_ERROR = "URI scheme is malformed.";
    function decodeValidScheme(scheme) {
      const decodedScheme = unescape(String(scheme));
      if (!VALID_SCHEME.test(decodedScheme)) {
        throw new TypeError(MALFORMED_SCHEME_ERROR);
      }
      return decodedScheme;
    }
    function normalize(uri, options) {
      if (typeof uri === "string") {
        uri = /** @type {T} */
        normalizeString(uri, options);
      } else if (typeof uri === "object") {
        uri = /** @type {T} */
        parse(serialize(uri, options), options);
      }
      return uri;
    }
    function resolve(baseURI, relativeURI, options) {
      const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
      const {
        parsed: baseParsed,
        malformedAuthorityOrPort: baseMalformed,
        malformedPercentEncoding: baseMalformedPercentEncoding,
        malformedSchemeSpecific: baseMalformedSchemeSpecific,
        malformedHost: baseMalformedHost,
        malformedScheme: baseMalformedScheme
      } = parseWithStatus(baseURI, schemelessOptions);
      const {
        parsed: relativeParsed,
        malformedAuthorityOrPort: relativeMalformed,
        malformedPercentEncoding: relativeMalformedPercentEncoding,
        malformedSchemeSpecific: relativeMalformedSchemeSpecific,
        malformedHost: relativeMalformedHost,
        malformedScheme: relativeMalformedScheme
      } = parseWithStatus(relativeURI, schemelessOptions);
      if (baseMalformed || relativeMalformed || baseMalformedPercentEncoding || relativeMalformedPercentEncoding || baseMalformedSchemeSpecific || relativeMalformedSchemeSpecific || baseMalformedHost || relativeMalformedHost || baseMalformedScheme || relativeMalformedScheme) {
        throw new Error(baseParsed.error || relativeParsed.error || "URI is malformed.");
      }
      const resolved = resolveComponent(baseParsed, relativeParsed, schemelessOptions, true);
      const resolvedSchemeHandler = getSchemeHandler(options && options.scheme || resolved.scheme);
      const resolvedHost = resolved.host;
      const resolvedHostIsIP = resolvedHost !== void 0 && resolvedHost !== "" && (isIPv4(resolvedHost) || normalizeIPv6(resolvedHost).isIPV6);
      canonicalizeHost(resolved, options || {}, resolvedSchemeHandler, resolvedHostIsIP);
      const encodedASCIIHost = resolvedHost && resolvedHost.indexOf("%") !== -1 && !new RegExp("\\P{ASCII}", "u").test(resolvedHost);
      if (resolved.error && !encodedASCIIHost) {
        throw new Error(resolved.error);
      }
      schemelessOptions.skipEscape = true;
      return serialize(resolved, schemelessOptions);
    }
    function resolveComponent(base, relative, options, skipNormalization) {
      const target = {};
      if (!skipNormalization) {
        base = parse(serialize(base, options), options);
        relative = parse(serialize(relative, options), options);
      }
      options = options || {};
      if (!options.tolerant && relative.scheme) {
        target.scheme = relative.scheme;
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (relative.userinfo !== void 0 || relative.host !== void 0 || relative.port !== void 0) {
          target.userinfo = relative.userinfo;
          target.host = relative.host;
          target.port = relative.port;
          target.path = removeDotSegments(relative.path || "");
          target.query = relative.query;
        } else {
          if (!relative.path) {
            target.path = base.path;
            if (relative.query !== void 0) {
              target.query = relative.query;
            } else {
              target.query = base.query;
            }
          } else {
            if (relative.path[0] === "/") {
              target.path = removeDotSegments(relative.path);
            } else {
              if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) {
                target.path = "/" + relative.path;
              } else if (!base.path) {
                target.path = relative.path;
              } else {
                target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
              }
              target.path = removeDotSegments(target.path);
            }
            target.query = relative.query;
          }
          target.userinfo = base.userinfo;
          target.host = base.host;
          target.port = base.port;
        }
        target.scheme = base.scheme;
      }
      target.fragment = relative.fragment;
      return target;
    }
    function equal(uriA, uriB, options) {
      const normalizedA = normalizeComparableURI(uriA, options);
      const normalizedB = normalizeComparableURI(uriB, options);
      return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA === normalizedB;
    }
    function serialize(cmpts, opts) {
      const component = {
        host: cmpts.host,
        scheme: cmpts.scheme,
        userinfo: cmpts.userinfo,
        port: cmpts.port,
        path: cmpts.path,
        query: cmpts.query,
        nid: cmpts.nid,
        nss: cmpts.nss,
        uuid: cmpts.uuid,
        fragment: cmpts.fragment,
        reference: cmpts.reference,
        resourceName: cmpts.resourceName,
        secure: cmpts.secure,
        error: ""
      };
      const options = Object.assign({}, opts);
      const uriTokens = [];
      if (component.scheme) {
        component.scheme = decodeValidScheme(component.scheme);
      }
      const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
      if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
      const hasAuthority = component.userinfo !== void 0 || component.host !== void 0 || component.port !== void 0;
      const pathNoScheme = !options.skipEscape && component.scheme === void 0 && !hasAuthority;
      if (component.path !== void 0) {
        if (!options.skipEscape) {
          component.path = serializePathEncoding(component.path, pathNoScheme);
        } else {
          component.path = normalizePercentEncoding(component.path);
        }
      }
      if (options.reference !== "suffix" && component.scheme) {
        component.scheme = decodeValidScheme(component.scheme);
        uriTokens.push(component.scheme, ":");
      }
      const authority = recomposeAuthority(component);
      if (authority !== void 0) {
        if (options.reference !== "suffix") {
          uriTokens.push("//");
        }
        uriTokens.push(authority);
        if (component.path && component.path[0] !== "/") {
          uriTokens.push("/");
        }
      }
      if (component.path !== void 0) {
        let s = component.path;
        if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
          s = removeDotSegments(s);
        }
        if (pathNoScheme) {
          s = serializePathEncoding(s, true);
        }
        if (authority === void 0 && s[0] === "/" && s[1] === "/") {
          s = "/%2F" + s.slice(2);
        }
        uriTokens.push(s);
      }
      if (component.query !== void 0) {
        uriTokens.push("?", encodeQuery(component.query));
      }
      if (component.fragment !== void 0) {
        uriTokens.push("#", encodeFragment(component.fragment));
      }
      return uriTokens.join("");
    }
    var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
    var AUTHORITY_PREFIX = /^(?:[^#/:?]+:)?\/\/([^/?#]*)/;
    var AUTHORITY_INTRODUCER_REGION = /^(?:[^#/:?]+:)?([/\\\t\n\r]*)/;
    function getParseError(parsed, matches) {
      if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") {
        return 'URI path must start with "/" when authority is present.';
      }
      if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) {
        return "URI port is malformed.";
      }
      return void 0;
    }
    function hasMalformedPercentEncoding(component) {
      if (component === void 0) return false;
      let percent = component.indexOf("%");
      while (percent !== -1) {
        if (percent + 2 >= component.length || !/^[\da-f]{2}$/iu.test(component.slice(percent + 1, percent + 3))) {
          return true;
        }
        percent = component.indexOf("%", percent + 3);
      }
      return false;
    }
    function isIPLiteral(host) {
      return host[0] === "[" && host[host.length - 1] === "]";
    }
    function hasMalformedComponentPercentEncoding(matches) {
      const host = matches[4];
      return hasMalformedPercentEncoding(matches[3]) || host !== void 0 && !isIPLiteral(host) && hasMalformedPercentEncoding(host) || hasMalformedPercentEncoding(matches[6]) || hasMalformedPercentEncoding(matches[7]) || hasMalformedPercentEncoding(matches[8]);
    }
    function canonicalizeHost(parsed, options, schemeHandler, isIP2) {
      if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport) && parsed.host && !isIPLiteral(parsed.host) && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP2 === false && nonSimpleDomain(parsed.host)) {
        try {
          parsed.host = new URL("http://" + parsed.host).hostname;
        } catch (e) {
          parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
          return true;
        }
      }
      return false;
    }
    function parseWithStatus(uri, opts) {
      const options = Object.assign({}, opts);
      const parsed = {
        scheme: void 0,
        userinfo: void 0,
        host: "",
        port: void 0,
        path: "",
        query: void 0,
        fragment: void 0
      };
      let malformedAuthorityOrPort = false;
      let malformedPercentEncoding = false;
      let malformedSchemeSpecific = false;
      let malformedHost = false;
      let malformedIPLiteral = false;
      let malformedScheme = false;
      let isIP2 = false;
      if (options.reference === "suffix") {
        if (options.scheme) {
          uri = options.scheme + ":" + uri;
        } else {
          uri = "//" + uri;
        }
      }
      const authorityMatch = uri.match(AUTHORITY_PREFIX);
      if (authorityMatch !== null && authorityMatch[1].indexOf("\\") !== -1) {
        parsed.error = "URI authority must not contain a literal backslash.";
        malformedAuthorityOrPort = true;
      }
      const introducerMatch = uri.match(AUTHORITY_INTRODUCER_REGION);
      if (introducerMatch !== null) {
        const region = introducerMatch[1];
        const normalizedRegion = region.replace(/[\t\n\r]/g, "");
        if (normalizedRegion.length >= 2) {
          if (normalizedRegion.slice(0, 2) !== "//") {
            parsed.error = parsed.error || "URI authority must not contain a literal backslash.";
            malformedAuthorityOrPort = true;
          } else if (region.length !== normalizedRegion.length) {
            parsed.error = parsed.error || "URI authority introducer must not contain whitespace.";
            malformedAuthorityOrPort = true;
          }
        }
      }
      const matches = uri.match(URI_PARSE);
      if (matches) {
        parsed.scheme = matches[1];
        parsed.userinfo = matches[3];
        parsed.host = matches[4];
        parsed.port = parseInt(matches[5], 10);
        parsed.path = matches[6] || "";
        parsed.query = matches[7];
        parsed.fragment = matches[8];
        if (parsed.scheme !== void 0) {
          const decodedScheme = unescape(parsed.scheme);
          if (VALID_SCHEME.test(decodedScheme)) {
            parsed.scheme = decodedScheme.toLowerCase();
          } else {
            parsed.error = parsed.error || MALFORMED_SCHEME_ERROR;
            malformedScheme = true;
          }
        }
        malformedPercentEncoding = hasMalformedComponentPercentEncoding(matches);
        if (malformedPercentEncoding) {
          parsed.error = parsed.error || "URI contains malformed percent-encoding.";
        }
        if (isNaN(parsed.port)) {
          parsed.port = matches[5];
        }
        const parseError = getParseError(parsed, matches);
        if (parseError !== void 0) {
          parsed.error = parsed.error || parseError;
          malformedAuthorityOrPort = true;
        }
        if (parsed.host) {
          const ipv4result = isIPv4(parsed.host);
          if (ipv4result === false) {
            const bracketedIPLiteral = isIPLiteral(parsed.host);
            const hasIPLiteralBracket = parsed.host.indexOf("[") !== -1 || parsed.host.indexOf("]") !== -1;
            const ipv6result = normalizeIPv6(parsed.host);
            isIP2 = ipv6result.isIPV6 || ipv6result.isIPVFuture === true;
            malformedIPLiteral = hasIPLiteralBracket && (!bracketedIPLiteral || ipv6result.error === true);
            parsed.host = isIP2 ? ipv6result.host : ipv6result.host.toLowerCase();
            if (malformedIPLiteral) {
              parsed.error = parsed.error || "URI host is malformed.";
              malformedAuthorityOrPort = true;
            }
          } else {
            isIP2 = true;
          }
        }
        if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) {
          parsed.reference = "same-document";
        } else if (parsed.scheme === void 0) {
          parsed.reference = "relative";
        } else if (parsed.fragment === void 0) {
          parsed.reference = "absolute";
        } else {
          parsed.reference = "uri";
        }
        if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
          parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
        }
        const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
        if (!malformedIPLiteral) {
          malformedHost = canonicalizeHost(parsed, options, schemeHandler, isIP2);
        }
        if (uri.indexOf("%") !== -1 && parsed.host !== void 0 && !malformedIPLiteral) {
          let host = isIP2 ? parsed.host : normalizePercentEncoding(parsed.host, true);
          if (!isIP2) {
            host = normalizePercentEncoding(host.toLowerCase());
          }
          parsed.host = reescapeHostDelimiters(host, isIP2);
        }
        if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
          if (parsed.path) {
            parsed.path = normalizePathEncoding(parsed.path);
          }
          if (parsed.query) {
            parsed.query = normalizeQueryFragmentEncoding(parsed.query);
          }
          if (parsed.fragment) {
            parsed.fragment = normalizeQueryFragmentEncoding(parsed.fragment);
          }
        }
        if (schemeHandler && schemeHandler.parse) {
          schemeHandler.parse(parsed, options);
          if (schemeHandler === SCHEMES.urn && parsed.nid === void 0) {
            malformedSchemeSpecific = true;
          }
        }
      } else {
        parsed.error = parsed.error || "URI can not be parsed.";
      }
      return { parsed, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme };
    }
    function parse(uri, opts) {
      return parseWithStatus(uri, opts).parsed;
    }
    function normalizeString(uri, opts) {
      return normalizeStringWithStatus(uri, opts).normalized;
    }
    function normalizeStringWithStatus(uri, opts) {
      const { parsed, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = parseWithStatus(uri, opts);
      return {
        normalized: malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? uri : serialize(parsed, opts),
        malformedAuthorityOrPort,
        malformedPercentEncoding,
        malformedSchemeSpecific,
        malformedHost,
        malformedScheme
      };
    }
    function normalizeComparableURI(uri, opts) {
      if (typeof uri !== "string" && typeof uri !== "object") {
        return void 0;
      }
      let value;
      try {
        value = typeof uri === "string" ? uri : serialize(uri, opts);
      } catch {
        return void 0;
      }
      const { normalized, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = normalizeStringWithStatus(value, opts);
      return malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? void 0 : normalized;
    }
    var fastUri = {
      SCHEMES,
      normalize,
      resolve,
      resolveComponent,
      equal,
      serialize,
      parse
    };
    module.exports = fastUri;
    module.exports.default = fastUri;
    module.exports.fastUri = fastUri;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/uri.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var uri = require_fast_uri();
    uri.code = 'require("ajv/dist/runtime/uri").default';
    exports.default = uri;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/core.js
var require_core = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/core.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    var ref_error_1 = require_ref_error();
    var rules_1 = require_rules();
    var compile_1 = require_compile();
    var codegen_2 = require_codegen();
    var resolve_1 = require_resolve();
    var dataType_1 = require_dataType();
    var util_1 = require_util();
    var $dataRefSchema = require_data();
    var uri_1 = require_uri();
    var defaultRegExp = (str, flags) => new RegExp(str, flags);
    defaultRegExp.code = "new RegExp";
    var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
    var EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
      "validate",
      "serialize",
      "parse",
      "wrapper",
      "root",
      "schema",
      "keyword",
      "pattern",
      "formats",
      "validate$data",
      "func",
      "obj",
      "Error"
    ]);
    var removedOptions = {
      errorDataPath: "",
      format: "`validateFormats: false` can be used instead.",
      nullable: '"nullable" keyword is supported by default.',
      jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
      extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
      missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
      processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
      sourceCode: "Use option `code: {source: true}`",
      strictDefaults: "It is default now, see option `strict`.",
      strictKeywords: "It is default now, see option `strict`.",
      uniqueItems: '"uniqueItems" keyword is always validated.',
      unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
      cache: "Map is used as cache, schema object as key.",
      serialize: "Map is used as cache, schema object as key.",
      ajvErrors: "It is default now."
    };
    var deprecatedOptions = {
      ignoreKeywordsWithRef: "",
      jsPropertySyntax: "",
      unicode: '"minLength"/"maxLength" account for unicode characters by default.'
    };
    var MAX_EXPRESSION = 200;
    function requiredOptions(o) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
      const s = o.strict;
      const _optz = (_a = o.code) === null || _a === void 0 ? void 0 : _a.optimize;
      const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
      const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
      const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
      return {
        strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
        strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
        strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
        strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
        strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
        code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
        loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
        loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
        meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
        messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
        inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
        schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
        addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
        validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
        validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
        unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
        int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
        uriResolver
      };
    }
    var Ajv = class {
      constructor(opts = {}) {
        this.schemas = {};
        this.refs = {};
        this.formats = /* @__PURE__ */ Object.create(null);
        this._compilations = /* @__PURE__ */ new Set();
        this._loading = {};
        this._cache = /* @__PURE__ */ new Map();
        opts = this.opts = { ...opts, ...requiredOptions(opts) };
        const { es5, lines } = this.opts.code;
        this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
        this.logger = getLogger(opts.logger);
        const formatOpt = opts.validateFormats;
        opts.validateFormats = false;
        this.RULES = (0, rules_1.getRules)();
        checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
        checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
        this._metaOpts = getMetaSchemaOptions.call(this);
        if (opts.formats)
          addInitialFormats.call(this);
        this._addVocabularies();
        this._addDefaultMetaSchema();
        if (opts.keywords)
          addInitialKeywords.call(this, opts.keywords);
        if (typeof opts.meta == "object")
          this.addMetaSchema(opts.meta);
        addInitialSchemas.call(this);
        opts.validateFormats = formatOpt;
      }
      _addVocabularies() {
        this.addKeyword("$async");
      }
      _addDefaultMetaSchema() {
        const { $data, meta, schemaId } = this.opts;
        let _dataRefSchema = $dataRefSchema;
        if (schemaId === "id") {
          _dataRefSchema = { ...$dataRefSchema };
          _dataRefSchema.id = _dataRefSchema.$id;
          delete _dataRefSchema.$id;
        }
        if (meta && $data)
          this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
      }
      defaultMeta() {
        const { meta, schemaId } = this.opts;
        return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : void 0;
      }
      validate(schemaKeyRef, data) {
        let v;
        if (typeof schemaKeyRef == "string") {
          v = this.getSchema(schemaKeyRef);
          if (!v)
            throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
        } else {
          v = this.compile(schemaKeyRef);
        }
        const valid = v(data);
        if (!("$async" in v))
          this.errors = v.errors;
        return valid;
      }
      compile(schema, _meta) {
        const sch = this._addSchema(schema, _meta);
        return sch.validate || this._compileSchemaEnv(sch);
      }
      compileAsync(schema, meta) {
        if (typeof this.opts.loadSchema != "function") {
          throw new Error("options.loadSchema should be a function");
        }
        const { loadSchema } = this.opts;
        return runCompileAsync.call(this, schema, meta);
        async function runCompileAsync(_schema, _meta) {
          await loadMetaSchema.call(this, _schema.$schema);
          const sch = this._addSchema(_schema, _meta);
          return sch.validate || _compileAsync.call(this, sch);
        }
        async function loadMetaSchema($ref) {
          if ($ref && !this.getSchema($ref)) {
            await runCompileAsync.call(this, { $ref }, true);
          }
        }
        async function _compileAsync(sch) {
          try {
            return this._compileSchemaEnv(sch);
          } catch (e) {
            if (!(e instanceof ref_error_1.default))
              throw e;
            checkLoaded.call(this, e);
            await loadMissingSchema.call(this, e.missingSchema);
            return _compileAsync.call(this, sch);
          }
        }
        function checkLoaded({ missingSchema: ref, missingRef }) {
          if (this.refs[ref]) {
            throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
          }
        }
        async function loadMissingSchema(ref) {
          const _schema = await _loadSchema.call(this, ref);
          if (!this.refs[ref])
            await loadMetaSchema.call(this, _schema.$schema);
          if (!this.refs[ref])
            this.addSchema(_schema, ref, meta);
        }
        async function _loadSchema(ref) {
          const p = this._loading[ref];
          if (p)
            return p;
          try {
            return await (this._loading[ref] = loadSchema(ref));
          } finally {
            delete this._loading[ref];
          }
        }
      }
      // Adds schema to the instance
      addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
        if (Array.isArray(schema)) {
          for (const sch of schema)
            this.addSchema(sch, void 0, _meta, _validateSchema);
          return this;
        }
        let id;
        if (typeof schema === "object") {
          const { schemaId } = this.opts;
          id = schema[schemaId];
          if (id !== void 0 && typeof id != "string") {
            throw new Error(`schema ${schemaId} must be string`);
          }
        }
        key = (0, resolve_1.normalizeId)(key || id);
        this._checkUnique(key);
        this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
        return this;
      }
      // Add schema that will be used to validate other schemas
      // options in META_IGNORE_OPTIONS are alway set to false
      addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
        this.addSchema(schema, key, true, _validateSchema);
        return this;
      }
      //  Validate schema against its meta-schema
      validateSchema(schema, throwOrLogError) {
        if (typeof schema == "boolean")
          return true;
        let $schema;
        $schema = schema.$schema;
        if ($schema !== void 0 && typeof $schema != "string") {
          throw new Error("$schema must be a string");
        }
        $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
        if (!$schema) {
          this.logger.warn("meta-schema not available");
          this.errors = null;
          return true;
        }
        const valid = this.validate($schema, schema);
        if (!valid && throwOrLogError) {
          const message2 = "schema is invalid: " + this.errorsText();
          if (this.opts.validateSchema === "log")
            this.logger.error(message2);
          else
            throw new Error(message2);
        }
        return valid;
      }
      // Get compiled schema by `key` or `ref`.
      // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
      getSchema(keyRef) {
        let sch;
        while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
          keyRef = sch;
        if (sch === void 0) {
          const { schemaId } = this.opts;
          const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
          sch = compile_1.resolveSchema.call(this, root, keyRef);
          if (!sch)
            return;
          this.refs[keyRef] = sch;
        }
        return sch.validate || this._compileSchemaEnv(sch);
      }
      // Remove cached schema(s).
      // If no parameter is passed all schemas but meta-schemas are removed.
      // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
      // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
      removeSchema(schemaKeyRef) {
        if (schemaKeyRef instanceof RegExp) {
          this._removeAllSchemas(this.schemas, schemaKeyRef);
          this._removeAllSchemas(this.refs, schemaKeyRef);
          return this;
        }
        switch (typeof schemaKeyRef) {
          case "undefined":
            this._removeAllSchemas(this.schemas);
            this._removeAllSchemas(this.refs);
            this._cache.clear();
            return this;
          case "string": {
            const sch = getSchEnv.call(this, schemaKeyRef);
            if (typeof sch == "object")
              this._cache.delete(sch.schema);
            delete this.schemas[schemaKeyRef];
            delete this.refs[schemaKeyRef];
            return this;
          }
          case "object": {
            const cacheKey = schemaKeyRef;
            this._cache.delete(cacheKey);
            let id = schemaKeyRef[this.opts.schemaId];
            if (id) {
              id = (0, resolve_1.normalizeId)(id);
              delete this.schemas[id];
              delete this.refs[id];
            }
            return this;
          }
          default:
            throw new Error("ajv.removeSchema: invalid parameter");
        }
      }
      // add "vocabulary" - a collection of keywords
      addVocabulary(definitions) {
        for (const def of definitions)
          this.addKeyword(def);
        return this;
      }
      addKeyword(kwdOrDef, def) {
        let keyword;
        if (typeof kwdOrDef == "string") {
          keyword = kwdOrDef;
          if (typeof def == "object") {
            this.logger.warn("these parameters are deprecated, see docs for addKeyword");
            def.keyword = keyword;
          }
        } else if (typeof kwdOrDef == "object" && def === void 0) {
          def = kwdOrDef;
          keyword = def.keyword;
          if (Array.isArray(keyword) && !keyword.length) {
            throw new Error("addKeywords: keyword must be string or non-empty array");
          }
        } else {
          throw new Error("invalid addKeywords parameters");
        }
        checkKeyword.call(this, keyword, def);
        if (!def) {
          (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
          return this;
        }
        keywordMetaschema.call(this, def);
        const definition = {
          ...def,
          type: (0, dataType_1.getJSONTypes)(def.type),
          schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
        };
        (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
        return this;
      }
      getKeyword(keyword) {
        const rule = this.RULES.all[keyword];
        return typeof rule == "object" ? rule.definition : !!rule;
      }
      // Remove keyword
      removeKeyword(keyword) {
        const { RULES } = this;
        delete RULES.keywords[keyword];
        delete RULES.all[keyword];
        for (const group of RULES.rules) {
          const i = group.rules.findIndex((rule) => rule.keyword === keyword);
          if (i >= 0)
            group.rules.splice(i, 1);
        }
        return this;
      }
      // Add format
      addFormat(name, format) {
        if (typeof format == "string")
          format = new RegExp(format);
        this.formats[name] = format;
        return this;
      }
      errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
        if (!errors || errors.length === 0)
          return "No errors";
        return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
      }
      $dataMetaSchema(metaSchema, keywordsJsonPointers) {
        const rules = this.RULES.all;
        metaSchema = JSON.parse(JSON.stringify(metaSchema));
        for (const jsonPointer of keywordsJsonPointers) {
          const segments = jsonPointer.split("/").slice(1);
          let keywords = metaSchema;
          for (const seg of segments)
            keywords = keywords[seg];
          for (const key in rules) {
            const rule = rules[key];
            if (typeof rule != "object")
              continue;
            const { $data } = rule.definition;
            const schema = keywords[key];
            if ($data && schema)
              keywords[key] = schemaOrData(schema);
          }
        }
        return metaSchema;
      }
      _removeAllSchemas(schemas, regex) {
        for (const keyRef in schemas) {
          const sch = schemas[keyRef];
          if (!regex || regex.test(keyRef)) {
            if (typeof sch == "string") {
              delete schemas[keyRef];
            } else if (sch && !sch.meta) {
              this._cache.delete(sch.schema);
              delete schemas[keyRef];
            }
          }
        }
      }
      _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
        let id;
        const { schemaId } = this.opts;
        if (typeof schema == "object") {
          id = schema[schemaId];
        } else {
          if (this.opts.jtd)
            throw new Error("schema must be object");
          else if (typeof schema != "boolean")
            throw new Error("schema must be object or boolean");
        }
        let sch = this._cache.get(schema);
        if (sch !== void 0)
          return sch;
        baseId = (0, resolve_1.normalizeId)(id || baseId);
        const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
        sch = new compile_1.SchemaEnv({ schema, schemaId, meta, baseId, localRefs });
        this._cache.set(sch.schema, sch);
        if (addSchema && !baseId.startsWith("#")) {
          if (baseId)
            this._checkUnique(baseId);
          this.refs[baseId] = sch;
        }
        if (validateSchema)
          this.validateSchema(schema, true);
        return sch;
      }
      _checkUnique(id) {
        if (this.schemas[id] || this.refs[id]) {
          throw new Error(`schema with key or id "${id}" already exists`);
        }
      }
      _compileSchemaEnv(sch) {
        if (sch.meta)
          this._compileMetaSchema(sch);
        else
          compile_1.compileSchema.call(this, sch);
        if (!sch.validate)
          throw new Error("ajv implementation error");
        return sch.validate;
      }
      _compileMetaSchema(sch) {
        const currentOpts = this.opts;
        this.opts = this._metaOpts;
        try {
          compile_1.compileSchema.call(this, sch);
        } finally {
          this.opts = currentOpts;
        }
      }
    };
    Ajv.ValidationError = validation_error_1.default;
    Ajv.MissingRefError = ref_error_1.default;
    exports.default = Ajv;
    function checkOptions(checkOpts, options, msg, log2 = "error") {
      for (const key in checkOpts) {
        const opt = key;
        if (opt in options)
          this.logger[log2](`${msg}: option ${key}. ${checkOpts[opt]}`);
      }
    }
    function getSchEnv(keyRef) {
      keyRef = (0, resolve_1.normalizeId)(keyRef);
      return this.schemas[keyRef] || this.refs[keyRef];
    }
    function addInitialSchemas() {
      const optsSchemas = this.opts.schemas;
      if (!optsSchemas)
        return;
      if (Array.isArray(optsSchemas))
        this.addSchema(optsSchemas);
      else
        for (const key in optsSchemas)
          this.addSchema(optsSchemas[key], key);
    }
    function addInitialFormats() {
      for (const name in this.opts.formats) {
        const format = this.opts.formats[name];
        if (format)
          this.addFormat(name, format);
      }
    }
    function addInitialKeywords(defs) {
      if (Array.isArray(defs)) {
        this.addVocabulary(defs);
        return;
      }
      this.logger.warn("keywords option as map is deprecated, pass array");
      for (const keyword in defs) {
        const def = defs[keyword];
        if (!def.keyword)
          def.keyword = keyword;
        this.addKeyword(def);
      }
    }
    function getMetaSchemaOptions() {
      const metaOpts = { ...this.opts };
      for (const opt of META_IGNORE_OPTIONS)
        delete metaOpts[opt];
      return metaOpts;
    }
    var noLogs = { log() {
    }, warn() {
    }, error() {
    } };
    function getLogger(logger) {
      if (logger === false)
        return noLogs;
      if (logger === void 0)
        return console;
      if (logger.log && logger.warn && logger.error)
        return logger;
      throw new Error("logger must implement log, warn and error methods");
    }
    var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
    function checkKeyword(keyword, def) {
      const { RULES } = this;
      (0, util_1.eachItem)(keyword, (kwd) => {
        if (RULES.keywords[kwd])
          throw new Error(`Keyword ${kwd} is already defined`);
        if (!KEYWORD_NAME.test(kwd))
          throw new Error(`Keyword ${kwd} has invalid name`);
      });
      if (!def)
        return;
      if (def.$data && !("code" in def || "validate" in def)) {
        throw new Error('$data keyword must have "code" or "validate" function');
      }
    }
    function addRule(keyword, definition, dataType) {
      var _a;
      const post = definition === null || definition === void 0 ? void 0 : definition.post;
      if (dataType && post)
        throw new Error('keyword with "post" flag cannot have "type"');
      const { RULES } = this;
      let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
      if (!ruleGroup) {
        ruleGroup = { type: dataType, rules: [] };
        RULES.rules.push(ruleGroup);
      }
      RULES.keywords[keyword] = true;
      if (!definition)
        return;
      const rule = {
        keyword,
        definition: {
          ...definition,
          type: (0, dataType_1.getJSONTypes)(definition.type),
          schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
        }
      };
      if (definition.before)
        addBeforeRule.call(this, ruleGroup, rule, definition.before);
      else
        ruleGroup.rules.push(rule);
      RULES.all[keyword] = rule;
      (_a = definition.implements) === null || _a === void 0 ? void 0 : _a.forEach((kwd) => this.addKeyword(kwd));
    }
    function addBeforeRule(ruleGroup, rule, before) {
      const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
      if (i >= 0) {
        ruleGroup.rules.splice(i, 0, rule);
      } else {
        ruleGroup.rules.push(rule);
        this.logger.warn(`rule ${before} is not defined`);
      }
    }
    function keywordMetaschema(def) {
      let { metaSchema } = def;
      if (metaSchema === void 0)
        return;
      if (def.$data && this.opts.$data)
        metaSchema = schemaOrData(metaSchema);
      def.validateSchema = this.compile(metaSchema, true);
    }
    var $dataRef = {
      $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
    };
    function schemaOrData(schema) {
      return { anyOf: [schema, $dataRef] };
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/id.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var def = {
      keyword: "id",
      code() {
        throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/ref.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.callRef = exports.getValidate = void 0;
    var ref_error_1 = require_ref_error();
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var util_1 = require_util();
    var def = {
      keyword: "$ref",
      schemaType: "string",
      code(cxt) {
        const { gen, schema: $ref, it } = cxt;
        const { baseId, schemaEnv: env, validateName, opts, self } = it;
        const { root } = env;
        if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
          return callRootRef();
        const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
        if (schOrEnv === void 0)
          throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
        if (schOrEnv instanceof compile_1.SchemaEnv)
          return callValidate(schOrEnv);
        return inlineRefSchema(schOrEnv);
        function callRootRef() {
          if (env === root)
            return callRef(cxt, validateName, env, env.$async);
          const rootName = gen.scopeValue("root", { ref: root });
          return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
        }
        function callValidate(sch) {
          const v = getValidate(cxt, sch);
          callRef(cxt, v, sch, sch.$async);
        }
        function inlineRefSchema(sch) {
          const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
          const valid = gen.name("valid");
          const schCxt = cxt.subschema({
            schema: sch,
            dataTypes: [],
            schemaPath: codegen_1.nil,
            topSchemaRef: schName,
            errSchemaPath: $ref
          }, valid);
          cxt.mergeEvaluated(schCxt);
          cxt.ok(valid);
        }
      }
    };
    function getValidate(cxt, sch) {
      const { gen } = cxt;
      return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
    }
    exports.getValidate = getValidate;
    function callRef(cxt, v, sch, $async) {
      const { gen, it } = cxt;
      const { allErrors, schemaEnv: env, opts } = it;
      const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
      if ($async)
        callAsyncRef();
      else
        callSyncRef();
      function callAsyncRef() {
        if (!env.$async)
          throw new Error("async schema referenced by sync schema");
        const valid = gen.let("valid");
        gen.try(() => {
          gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
          addEvaluatedFrom(v);
          if (!allErrors)
            gen.assign(valid, true);
        }, (e) => {
          gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
          addErrorsFrom(e);
          if (!allErrors)
            gen.assign(valid, false);
        });
        cxt.ok(valid);
      }
      function callSyncRef() {
        cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
      }
      function addErrorsFrom(source) {
        const errs = (0, codegen_1._)`${source}.errors`;
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
        gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      }
      function addEvaluatedFrom(source) {
        var _a;
        if (!it.opts.unevaluated)
          return;
        const schEvaluated = (_a = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a === void 0 ? void 0 : _a.evaluated;
        if (it.props !== true) {
          if (schEvaluated && !schEvaluated.dynamicProps) {
            if (schEvaluated.props !== void 0) {
              it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
            }
          } else {
            const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
            it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
          }
        }
        if (it.items !== true) {
          if (schEvaluated && !schEvaluated.dynamicItems) {
            if (schEvaluated.items !== void 0) {
              it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
            }
          } else {
            const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
            it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
          }
        }
      }
    }
    exports.callRef = callRef;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var id_1 = require_id();
    var ref_1 = require_ref();
    var core = [
      "$schema",
      "$id",
      "$defs",
      "$vocabulary",
      { keyword: "$comment" },
      "definitions",
      id_1.default,
      ref_1.default
    ];
    exports.default = core;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitNumber.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    var def = {
      keyword: Object.keys(KWDs),
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/multipleOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    };
    var def = {
      keyword: "multipleOf",
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, schemaCode, it } = cxt;
        const prec = it.opts.multipleOfPrecision;
        const res = gen.let("res");
        const invalid2 = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
        cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid2}))`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitLength.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var ucs2length_1 = require_ucs2length();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxLength", "minLength"],
      type: "string",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode, it } = cxt;
        const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
        const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
        cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/pattern.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var util_1 = require_util();
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    };
    var def = {
      keyword: "pattern",
      type: "string",
      schemaType: "string",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const u = it.opts.unicodeRegExp ? "u" : "";
        if ($data) {
          const { regExp } = it.opts.code;
          const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
          const valid = gen.let("valid");
          gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
          cxt.fail$data((0, codegen_1._)`!${valid}`);
        } else {
          const regExp = (0, code_1.usePattern)(cxt, schema);
          cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxProperties", "minProperties"],
      type: "object",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/required.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    };
    var def = {
      keyword: "required",
      type: "object",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, schema, schemaCode, data, $data, it } = cxt;
        const { opts } = it;
        if (!$data && schema.length === 0)
          return;
        const useLoop = schema.length >= opts.loopRequired;
        if (it.allErrors)
          allErrorsMode();
        else
          exitOnErrorMode();
        if (opts.strictRequired) {
          const props = cxt.parentSchema.properties;
          const { definedProperties } = cxt.it;
          for (const requiredKey of schema) {
            if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
              const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
              const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
              (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
            }
          }
        }
        function allErrorsMode() {
          if (useLoop || $data) {
            cxt.block$data(codegen_1.nil, loopAllRequired);
          } else {
            for (const prop of schema) {
              (0, code_1.checkReportMissingProp)(cxt, prop);
            }
          }
        }
        function exitOnErrorMode() {
          const missing = gen.let("missing");
          if (useLoop || $data) {
            const valid = gen.let("valid", true);
            cxt.block$data(valid, () => loopUntilMissing(missing, valid));
            cxt.ok(valid);
          } else {
            gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
            (0, code_1.reportMissingProp)(cxt, missing);
            gen.else();
          }
        }
        function loopAllRequired() {
          gen.forOf("prop", schemaCode, (prop) => {
            cxt.setParams({ missingProperty: prop });
            gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
          });
        }
        function loopUntilMissing(missing, valid) {
          cxt.setParams({ missingProperty: missing });
          gen.forOf(missing, schemaCode, () => {
            gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.error();
              gen.break();
            });
          }, codegen_1.nil);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxItems", "minItems"],
      type: "array",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports.default = equal;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/uniqueItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dataType_1 = require_dataType();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    };
    var def = {
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
        if (!$data && !schema)
          return;
        const valid = gen.let("valid");
        const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
        cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
        cxt.ok(valid);
        function validateUniqueItems() {
          const i = gen.let("i", (0, codegen_1._)`${data}.length`);
          const j = gen.let("j");
          cxt.setParams({ i, j });
          gen.assign(valid, true);
          gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
        }
        function canOptimize() {
          return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
        }
        function loopN(i, j) {
          const item = gen.name("item");
          const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
          const indices = gen.const("indices", (0, codegen_1._)`{}`);
          gen.for((0, codegen_1._)`;${i}--;`, () => {
            gen.let(item, (0, codegen_1._)`${data}[${i}]`);
            gen.if(wrongType, (0, codegen_1._)`continue`);
            if (itemTypes.length > 1)
              gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
            gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
              gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
              cxt.error();
              gen.assign(valid, false).break();
            }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
          });
        }
        function loopN2(i, j) {
          const eql = (0, util_1.useFunc)(gen, equal_1.default);
          const outer = gen.name("outer");
          gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          })));
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/const.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    };
    var def = {
      keyword: "const",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schemaCode, schema } = cxt;
        if ($data || schema && typeof schema == "object") {
          cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
        } else {
          cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/enum.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    };
    var def = {
      keyword: "enum",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        if (!$data && schema.length === 0)
          throw new Error("enum must have non-empty array");
        const useLoop = schema.length >= it.opts.loopEnum;
        let eql;
        const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
        let valid;
        if (useLoop || $data) {
          valid = gen.let("valid");
          cxt.block$data(valid, loopEnum);
        } else {
          if (!Array.isArray(schema))
            throw new Error("ajv implementation error");
          const vSchema = gen.const("vSchema", schemaCode);
          valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
        }
        cxt.pass(valid);
        function loopEnum() {
          gen.assign(valid, false);
          gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
        }
        function equalCode(vSchema, i) {
          const sch = schema[i];
          return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var limitNumber_1 = require_limitNumber();
    var multipleOf_1 = require_multipleOf();
    var limitLength_1 = require_limitLength();
    var pattern_1 = require_pattern();
    var limitProperties_1 = require_limitProperties();
    var required_1 = require_required();
    var limitItems_1 = require_limitItems();
    var uniqueItems_1 = require_uniqueItems();
    var const_1 = require_const();
    var enum_1 = require_enum();
    var validation = [
      // number
      limitNumber_1.default,
      multipleOf_1.default,
      // string
      limitLength_1.default,
      pattern_1.default,
      // object
      limitProperties_1.default,
      required_1.default,
      // array
      limitItems_1.default,
      uniqueItems_1.default,
      // any
      { keyword: "type", schemaType: ["string", "array"] },
      { keyword: "nullable", schemaType: "boolean" },
      const_1.default,
      enum_1.default
    ];
    exports.default = validation;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateAdditionalItems = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "additionalItems",
      type: "array",
      schemaType: ["boolean", "object"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { parentSchema, it } = cxt;
        const { items } = parentSchema;
        if (!Array.isArray(items)) {
          (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
          return;
        }
        validateAdditionalItems(cxt, items);
      }
    };
    function validateAdditionalItems(cxt, items) {
      const { gen, schema, data, keyword, it } = cxt;
      it.items = true;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items.length });
        cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
        cxt.ok(valid);
      }
      function validateItems(valid) {
        gen.forRange("i", items.length, len, (i) => {
          cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
    exports.validateAdditionalItems = validateAdditionalItems;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateTuple = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "array", "boolean"],
      before: "uniqueItems",
      code(cxt) {
        const { schema, it } = cxt;
        if (Array.isArray(schema))
          return validateTuple(cxt, "additionalItems", schema);
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    function validateTuple(cxt, extraItems, schArr = cxt.schema) {
      const { gen, parentSchema, data, keyword, it } = cxt;
      checkStrictTuple(parentSchema);
      if (it.opts.unevaluated && schArr.length && it.items !== true) {
        it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
      }
      const valid = gen.name("valid");
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      schArr.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
          keyword,
          schemaProp: i,
          dataProp: i
        }, valid));
        cxt.ok(valid);
      });
      function checkStrictTuple(sch) {
        const { opts, errSchemaPath } = it;
        const l = schArr.length;
        const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
        if (opts.strictTuples && !fullTuple) {
          const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
          (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
        }
      }
    }
    exports.validateTuple = validateTuple;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/prefixItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var items_1 = require_items();
    var def = {
      keyword: "prefixItems",
      type: "array",
      schemaType: ["array"],
      before: "uniqueItems",
      code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var additionalItems_1 = require_additionalItems();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { schema, parentSchema, it } = cxt;
        const { prefixItems } = parentSchema;
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        if (prefixItems)
          (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
        else
          cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/contains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    };
    var def = {
      keyword: "contains",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        let min;
        let max;
        const { minContains, maxContains } = parentSchema;
        if (it.opts.next) {
          min = minContains === void 0 ? 1 : minContains;
          max = maxContains;
        } else {
          min = 1;
        }
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        cxt.setParams({ min, max });
        if (max === void 0 && min === 0) {
          (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
          return;
        }
        if (max !== void 0 && min > max) {
          (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
          cxt.fail();
          return;
        }
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          let cond = (0, codegen_1._)`${len} >= ${min}`;
          if (max !== void 0)
            cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
          cxt.pass(cond);
          return;
        }
        it.items = true;
        const valid = gen.name("valid");
        if (max === void 0 && min === 1) {
          validateItems(valid, () => gen.if(valid, () => gen.break()));
        } else if (min === 0) {
          gen.let(valid, true);
          if (max !== void 0)
            gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
        } else {
          gen.let(valid, false);
          validateItemsWithCount();
        }
        cxt.result(valid, () => cxt.reset());
        function validateItemsWithCount() {
          const schValid = gen.name("_valid");
          const count2 = gen.let("count", 0);
          validateItems(schValid, () => gen.if(schValid, () => checkLimits(count2)));
        }
        function validateItems(_valid, block) {
          gen.forRange("i", 0, len, (i) => {
            cxt.subschema({
              keyword: "contains",
              dataProp: i,
              dataPropType: util_1.Type.Num,
              compositeRule: true
            }, _valid);
            block();
          });
        }
        function checkLimits(count2) {
          gen.code((0, codegen_1._)`${count2}++`);
          if (max === void 0) {
            gen.if((0, codegen_1._)`${count2} >= ${min}`, () => gen.assign(valid, true).break());
          } else {
            gen.if((0, codegen_1._)`${count2} > ${max}`, () => gen.assign(valid, false).break());
            if (min === 1)
              gen.assign(valid, true);
            else
              gen.if((0, codegen_1._)`${count2} >= ${min}`, () => gen.assign(valid, true));
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependencies.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    exports.error = {
      message: ({ params: { property, depsCount, deps } }) => {
        const property_ies = depsCount === 1 ? "property" : "properties";
        return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
      },
      params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
      // TODO change to reference
    };
    var def = {
      keyword: "dependencies",
      type: "object",
      schemaType: "object",
      error: exports.error,
      code(cxt) {
        const [propDeps, schDeps] = splitDependencies(cxt);
        validatePropertyDeps(cxt, propDeps);
        validateSchemaDeps(cxt, schDeps);
      }
    };
    function splitDependencies({ schema }) {
      const propertyDeps = {};
      const schemaDeps = {};
      for (const key in schema) {
        if (key === "__proto__")
          continue;
        const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
        deps[key] = schema[key];
      }
      return [propertyDeps, schemaDeps];
    }
    function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
      const { gen, data, it } = cxt;
      if (Object.keys(propertyDeps).length === 0)
        return;
      const missing = gen.let("missing");
      for (const prop in propertyDeps) {
        const deps = propertyDeps[prop];
        if (deps.length === 0)
          continue;
        const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
        cxt.setParams({
          property: prop,
          depsCount: deps.length,
          deps: deps.join(", ")
        });
        if (it.allErrors) {
          gen.if(hasProperty, () => {
            for (const depProp of deps) {
              (0, code_1.checkReportMissingProp)(cxt, depProp);
            }
          });
        } else {
          gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
    }
    exports.validatePropertyDeps = validatePropertyDeps;
    function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      for (const prop in schemaDeps) {
        if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
          continue;
        gen.if(
          (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties),
          () => {
            const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
            cxt.mergeValidEvaluated(schCxt, valid);
          },
          () => gen.var(valid, true)
          // TODO var
        );
        cxt.ok(valid);
      }
    }
    exports.validateSchemaDeps = validateSchemaDeps;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/propertyNames.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    };
    var def = {
      keyword: "propertyNames",
      type: "object",
      schemaType: ["object", "boolean"],
      error,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        const valid = gen.name("valid");
        gen.forIn("key", data, (key) => {
          cxt.setParams({ propertyName: key });
          cxt.subschema({
            keyword: "propertyNames",
            data: key,
            dataTypes: ["string"],
            propertyName: key,
            compositeRule: true
          }, valid);
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error(true);
            if (!it.allErrors)
              gen.break();
          });
        });
        cxt.ok(valid);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var util_1 = require_util();
    var error = {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    };
    var def = {
      keyword: "additionalProperties",
      type: ["object"],
      schemaType: ["boolean", "object"],
      allowUndefined: true,
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, opts } = it;
        it.props = true;
        if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
          return;
        const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
        const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
        checkAdditionalProperties();
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function checkAdditionalProperties() {
          gen.forIn("key", data, (key) => {
            if (!props.length && !patProps.length)
              additionalPropertyCode(key);
            else
              gen.if(isAdditional(key), () => additionalPropertyCode(key));
          });
        }
        function isAdditional(key) {
          let definedProp;
          if (props.length > 8) {
            const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
            definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
          } else if (props.length) {
            definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
          } else {
            definedProp = codegen_1.nil;
          }
          if (patProps.length) {
            definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
          }
          return (0, codegen_1.not)(definedProp);
        }
        function deleteAdditional(key) {
          gen.code((0, codegen_1._)`delete ${data}[${key}]`);
        }
        function additionalPropertyCode(key) {
          if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
            deleteAdditional(key);
            return;
          }
          if (schema === false) {
            cxt.setParams({ additionalProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            if (opts.removeAdditional === "failing") {
              applyAdditionalSchema(key, valid, false);
              gen.if((0, codegen_1.not)(valid), () => {
                cxt.reset();
                deleteAdditional(key);
              });
            } else {
              applyAdditionalSchema(key, valid);
              if (!allErrors)
                gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          }
        }
        function applyAdditionalSchema(key, valid, errors) {
          const subschema = {
            keyword: "additionalProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          };
          if (errors === false) {
            Object.assign(subschema, {
              compositeRule: true,
              createErrors: false,
              allErrors: false
            });
          }
          cxt.subschema(subschema, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/properties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var validate_1 = require_validate();
    var code_1 = require_code2();
    var util_1 = require_util();
    var additionalProperties_1 = require_additionalProperties();
    var def = {
      keyword: "properties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) {
          additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
        }
        const allProps = (0, code_1.allSchemaProperties)(schema);
        for (const prop of allProps) {
          it.definedProperties.add(prop);
        }
        if (it.opts.unevaluated && allProps.length && it.props !== true) {
          it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
        }
        const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
        if (properties.length === 0)
          return;
        const valid = gen.name("valid");
        for (const prop of properties) {
          if (hasDefault(prop)) {
            applyPropertySchema(prop);
          } else {
            gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
            applyPropertySchema(prop);
            if (!it.allErrors)
              gen.else().var(valid, true);
            gen.endIf();
          }
          cxt.it.definedProperties.add(prop);
          cxt.ok(valid);
        }
        function hasDefault(prop) {
          return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
        }
        function applyPropertySchema(prop) {
          cxt.subschema({
            keyword: "properties",
            schemaProp: prop,
            dataProp: prop
          }, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/patternProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var util_2 = require_util();
    var def = {
      keyword: "patternProperties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, data, parentSchema, it } = cxt;
        const { opts } = it;
        const patterns = (0, code_1.allSchemaProperties)(schema);
        const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
        if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
          return;
        }
        const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
        const valid = gen.name("valid");
        if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
          it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
        }
        const { props } = it;
        validatePatternProperties();
        function validatePatternProperties() {
          for (const pat of patterns) {
            if (checkProperties)
              checkMatchingProperties(pat);
            if (it.allErrors) {
              validateProperties(pat);
            } else {
              gen.var(valid, true);
              validateProperties(pat);
              gen.if(valid);
            }
          }
        }
        function checkMatchingProperties(pat) {
          for (const prop in checkProperties) {
            if (new RegExp(pat).test(prop)) {
              (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
            }
          }
        }
        function validateProperties(pat) {
          gen.forIn("key", data, (key) => {
            gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
              const alwaysValid = alwaysValidPatterns.includes(pat);
              if (!alwaysValid) {
                cxt.subschema({
                  keyword: "patternProperties",
                  schemaProp: pat,
                  dataProp: key,
                  dataPropType: util_2.Type.Str
                }, valid);
              }
              if (it.opts.unevaluated && props !== true) {
                gen.assign((0, codegen_1._)`${props}[${key}]`, true);
              } else if (!alwaysValid && !it.allErrors) {
                gen.if((0, codegen_1.not)(valid), () => gen.break());
              }
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/not.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "not",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      code(cxt) {
        const { gen, schema, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          cxt.fail();
          return;
        }
        const valid = gen.name("valid");
        cxt.subschema({
          keyword: "not",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, valid);
        cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
      },
      error: { message: "must NOT be valid" }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/anyOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var def = {
      keyword: "anyOf",
      schemaType: "array",
      trackErrors: true,
      code: code_1.validateUnion,
      error: { message: "must match a schema in anyOf" }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/oneOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    };
    var def = {
      keyword: "oneOf",
      schemaType: "array",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        if (it.opts.discriminator && parentSchema.discriminator)
          return;
        const schArr = schema;
        const valid = gen.let("valid", false);
        const passing = gen.let("passing", null);
        const schValid = gen.name("_valid");
        cxt.setParams({ passing });
        gen.block(validateOneOf);
        cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
        function validateOneOf() {
          schArr.forEach((sch, i) => {
            let schCxt;
            if ((0, util_1.alwaysValidSchema)(it, sch)) {
              gen.var(schValid, true);
            } else {
              schCxt = cxt.subschema({
                keyword: "oneOf",
                schemaProp: i,
                compositeRule: true
              }, schValid);
            }
            if (i > 0) {
              gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
            }
            gen.if(schValid, () => {
              gen.assign(valid, true);
              gen.assign(passing, i);
              if (schCxt)
                cxt.mergeEvaluated(schCxt, codegen_1.Name);
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/allOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "allOf",
      schemaType: "array",
      code(cxt) {
        const { gen, schema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const valid = gen.name("valid");
        schema.forEach((sch, i) => {
          if ((0, util_1.alwaysValidSchema)(it, sch))
            return;
          const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
          cxt.ok(valid);
          cxt.mergeEvaluated(schCxt);
        });
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/if.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    };
    var def = {
      keyword: "if",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, parentSchema, it } = cxt;
        if (parentSchema.then === void 0 && parentSchema.else === void 0) {
          (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
        }
        const hasThen = hasSchema(it, "then");
        const hasElse = hasSchema(it, "else");
        if (!hasThen && !hasElse)
          return;
        const valid = gen.let("valid", true);
        const schValid = gen.name("_valid");
        validateIf();
        cxt.reset();
        if (hasThen && hasElse) {
          const ifClause = gen.let("ifClause");
          cxt.setParams({ ifClause });
          gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
        } else if (hasThen) {
          gen.if(schValid, validateClause("then"));
        } else {
          gen.if((0, codegen_1.not)(schValid), validateClause("else"));
        }
        cxt.pass(valid, () => cxt.error(true));
        function validateIf() {
          const schCxt = cxt.subschema({
            keyword: "if",
            compositeRule: true,
            createErrors: false,
            allErrors: false
          }, schValid);
          cxt.mergeEvaluated(schCxt);
        }
        function validateClause(keyword, ifClause) {
          return () => {
            const schCxt = cxt.subschema({ keyword }, schValid);
            gen.assign(valid, schValid);
            cxt.mergeValidEvaluated(schCxt, valid);
            if (ifClause)
              gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
            else
              cxt.setParams({ ifClause: keyword });
          };
        }
      }
    };
    function hasSchema(it, keyword) {
      const schema = it.schema[keyword];
      return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
    }
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/thenElse.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["then", "else"],
      schemaType: ["object", "boolean"],
      code({ keyword, parentSchema, it }) {
        if (parentSchema.if === void 0)
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var additionalItems_1 = require_additionalItems();
    var prefixItems_1 = require_prefixItems();
    var items_1 = require_items();
    var items2020_1 = require_items2020();
    var contains_1 = require_contains();
    var dependencies_1 = require_dependencies();
    var propertyNames_1 = require_propertyNames();
    var additionalProperties_1 = require_additionalProperties();
    var properties_1 = require_properties();
    var patternProperties_1 = require_patternProperties();
    var not_1 = require_not();
    var anyOf_1 = require_anyOf();
    var oneOf_1 = require_oneOf();
    var allOf_1 = require_allOf();
    var if_1 = require_if();
    var thenElse_1 = require_thenElse();
    function getApplicator(draft2020 = false) {
      const applicator = [
        // any
        not_1.default,
        anyOf_1.default,
        oneOf_1.default,
        allOf_1.default,
        if_1.default,
        thenElse_1.default,
        // object
        propertyNames_1.default,
        additionalProperties_1.default,
        dependencies_1.default,
        properties_1.default,
        patternProperties_1.default
      ];
      if (draft2020)
        applicator.push(prefixItems_1.default, items2020_1.default);
      else
        applicator.push(additionalItems_1.default, items_1.default);
      applicator.push(contains_1.default);
      return applicator;
    }
    exports.default = getApplicator;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicAnchor.js
var require_dynamicAnchor = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicAnchor.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.dynamicAnchor = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var ref_1 = require_ref();
    var def = {
      keyword: "$dynamicAnchor",
      schemaType: "string",
      code: (cxt) => dynamicAnchor(cxt, cxt.schema)
    };
    function dynamicAnchor(cxt, anchor) {
      const { gen, it } = cxt;
      it.schemaEnv.root.dynamicAnchors[anchor] = true;
      const v = (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`;
      const validate = it.errSchemaPath === "#" ? it.validateName : _getValidate(cxt);
      gen.if((0, codegen_1._)`!${v}`, () => gen.assign(v, validate));
    }
    exports.dynamicAnchor = dynamicAnchor;
    function _getValidate(cxt) {
      const { schemaEnv, schema, self } = cxt.it;
      const { root, baseId, localRefs, meta } = schemaEnv.root;
      const { schemaId } = self.opts;
      const sch = new compile_1.SchemaEnv({ schema, schemaId, root, baseId, localRefs, meta });
      compile_1.compileSchema.call(self, sch);
      return (0, ref_1.getValidate)(cxt, sch);
    }
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicRef.js
var require_dynamicRef = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicRef.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.dynamicRef = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var ref_1 = require_ref();
    var def = {
      keyword: "$dynamicRef",
      schemaType: "string",
      code: (cxt) => dynamicRef(cxt, cxt.schema)
    };
    function dynamicRef(cxt, ref) {
      const { gen, keyword, it } = cxt;
      if (ref[0] !== "#")
        throw new Error(`"${keyword}" only supports hash fragment reference`);
      const anchor = ref.slice(1);
      if (it.allErrors) {
        _dynamicRef();
      } else {
        const valid = gen.let("valid", false);
        _dynamicRef(valid);
        cxt.ok(valid);
      }
      function _dynamicRef(valid) {
        if (it.schemaEnv.root.dynamicAnchors[anchor]) {
          const v = gen.let("_v", (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`);
          gen.if(v, _callRef(v, valid), _callRef(it.validateName, valid));
        } else {
          _callRef(it.validateName, valid)();
        }
      }
      function _callRef(validate, valid) {
        return valid ? () => gen.block(() => {
          (0, ref_1.callRef)(cxt, validate);
          gen.let(valid, true);
        }) : () => (0, ref_1.callRef)(cxt, validate);
      }
    }
    exports.dynamicRef = dynamicRef;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveAnchor.js
var require_recursiveAnchor = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveAnchor.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicAnchor_1 = require_dynamicAnchor();
    var util_1 = require_util();
    var def = {
      keyword: "$recursiveAnchor",
      schemaType: "boolean",
      code(cxt) {
        if (cxt.schema)
          (0, dynamicAnchor_1.dynamicAnchor)(cxt, "");
        else
          (0, util_1.checkStrictMode)(cxt.it, "$recursiveAnchor: false is ignored");
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveRef.js
var require_recursiveRef = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveRef.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicRef_1 = require_dynamicRef();
    var def = {
      keyword: "$recursiveRef",
      schemaType: "string",
      code: (cxt) => (0, dynamicRef_1.dynamicRef)(cxt, cxt.schema)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/index.js
var require_dynamic = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicAnchor_1 = require_dynamicAnchor();
    var dynamicRef_1 = require_dynamicRef();
    var recursiveAnchor_1 = require_recursiveAnchor();
    var recursiveRef_1 = require_recursiveRef();
    var dynamic = [dynamicAnchor_1.default, dynamicRef_1.default, recursiveAnchor_1.default, recursiveRef_1.default];
    exports.default = dynamic;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/dependentRequired.js
var require_dependentRequired = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/dependentRequired.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependencies_1 = require_dependencies();
    var def = {
      keyword: "dependentRequired",
      type: "object",
      schemaType: "object",
      error: dependencies_1.error,
      code: (cxt) => (0, dependencies_1.validatePropertyDeps)(cxt)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependentSchemas.js
var require_dependentSchemas = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependentSchemas.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependencies_1 = require_dependencies();
    var def = {
      keyword: "dependentSchemas",
      type: "object",
      schemaType: "object",
      code: (cxt) => (0, dependencies_1.validateSchemaDeps)(cxt)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitContains.js
var require_limitContains = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitContains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["maxContains", "minContains"],
      type: "array",
      schemaType: "number",
      code({ keyword, parentSchema, it }) {
        if (parentSchema.contains === void 0) {
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "contains" is ignored`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/next.js
var require_next = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/next.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependentRequired_1 = require_dependentRequired();
    var dependentSchemas_1 = require_dependentSchemas();
    var limitContains_1 = require_limitContains();
    var next = [dependentRequired_1.default, dependentSchemas_1.default, limitContains_1.default];
    exports.default = next;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedProperties.js
var require_unevaluatedProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var error = {
      message: "must NOT have unevaluated properties",
      params: ({ params }) => (0, codegen_1._)`{unevaluatedProperty: ${params.unevaluatedProperty}}`
    };
    var def = {
      keyword: "unevaluatedProperties",
      type: "object",
      schemaType: ["boolean", "object"],
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, props } = it;
        if (props instanceof codegen_1.Name) {
          gen.if((0, codegen_1._)`${props} !== true`, () => gen.forIn("key", data, (key) => gen.if(unevaluatedDynamic(props, key), () => unevaluatedPropCode(key))));
        } else if (props !== true) {
          gen.forIn("key", data, (key) => props === void 0 ? unevaluatedPropCode(key) : gen.if(unevaluatedStatic(props, key), () => unevaluatedPropCode(key)));
        }
        it.props = true;
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function unevaluatedPropCode(key) {
          if (schema === false) {
            cxt.setParams({ unevaluatedProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (!(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            cxt.subschema({
              keyword: "unevaluatedProperties",
              dataProp: key,
              dataPropType: util_1.Type.Str
            }, valid);
            if (!allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          }
        }
        function unevaluatedDynamic(evaluatedProps, key) {
          return (0, codegen_1._)`!${evaluatedProps} || !${evaluatedProps}[${key}]`;
        }
        function unevaluatedStatic(evaluatedProps, key) {
          const ps = [];
          for (const p in evaluatedProps) {
            if (evaluatedProps[p] === true)
              ps.push((0, codegen_1._)`${key} !== ${p}`);
          }
          return (0, codegen_1.and)(...ps);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedItems.js
var require_unevaluatedItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "unevaluatedItems",
      type: "array",
      schemaType: ["boolean", "object"],
      error,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        const items = it.items || 0;
        if (items === true)
          return;
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        if (schema === false) {
          cxt.setParams({ len: items });
          cxt.fail((0, codegen_1._)`${len} > ${items}`);
        } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items}`);
          gen.if((0, codegen_1.not)(valid), () => validateItems(valid, items));
          cxt.ok(valid);
        }
        it.items = true;
        function validateItems(valid, from) {
          gen.forRange("i", from, len, (i) => {
            cxt.subschema({ keyword: "unevaluatedItems", dataProp: i, dataPropType: util_1.Type.Num }, valid);
            if (!it.allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/index.js
var require_unevaluated = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var unevaluatedProperties_1 = require_unevaluatedProperties();
    var unevaluatedItems_1 = require_unevaluatedItems();
    var unevaluated = [unevaluatedProperties_1.default, unevaluatedItems_1.default];
    exports.default = unevaluated;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/format.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    };
    var def = {
      keyword: "format",
      type: ["number", "string"],
      schemaType: "string",
      $data: true,
      error,
      code(cxt, ruleType) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const { opts, errSchemaPath, schemaEnv, self } = it;
        if (!opts.validateFormats)
          return;
        if ($data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
          const fType = gen.let("fType");
          const format = gen.let("format");
          gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
          cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
          function unknownFmt() {
            if (opts.strictSchema === false)
              return codegen_1.nil;
            return (0, codegen_1._)`${schemaCode} && !${format}`;
          }
          function invalidFmt() {
            const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
            const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
            return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
          }
        }
        function validateFormat() {
          const formatDef = self.formats[schema];
          if (!formatDef) {
            unknownFormat();
            return;
          }
          if (formatDef === true)
            return;
          const [fmtType, format, fmtRef] = getFormat(formatDef);
          if (fmtType === ruleType)
            cxt.pass(validCondition());
          function unknownFormat() {
            if (opts.strictSchema === false) {
              self.logger.warn(unknownMsg());
              return;
            }
            throw new Error(unknownMsg());
            function unknownMsg() {
              return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
            }
          }
          function getFormat(fmtDef) {
            const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
            const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
            if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
              return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
            }
            return ["string", fmtDef, fmt];
          }
          function validCondition() {
            if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
              if (!schemaEnv.$async)
                throw new Error("async format in sync schema");
              return (0, codegen_1._)`await ${fmtRef}(${data})`;
            }
            return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var format_1 = require_format();
    var format = [format_1.default];
    exports.default = format;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/metadata.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.contentVocabulary = exports.metadataVocabulary = void 0;
    exports.metadataVocabulary = [
      "title",
      "description",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "examples"
    ];
    exports.contentVocabulary = [
      "contentMediaType",
      "contentEncoding",
      "contentSchema"
    ];
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/draft2020.js
var require_draft2020 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/draft2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var core_1 = require_core2();
    var validation_1 = require_validation();
    var applicator_1 = require_applicator();
    var dynamic_1 = require_dynamic();
    var next_1 = require_next();
    var unevaluated_1 = require_unevaluated();
    var format_1 = require_format2();
    var metadata_1 = require_metadata();
    var draft2020Vocabularies = [
      dynamic_1.default,
      core_1.default,
      validation_1.default,
      (0, applicator_1.default)(true),
      format_1.default,
      metadata_1.metadataVocabulary,
      metadata_1.contentVocabulary,
      next_1.default,
      unevaluated_1.default
    ];
    exports.default = draft2020Vocabularies;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiscrError = void 0;
    var DiscrError;
    (function(DiscrError2) {
      DiscrError2["Tag"] = "tag";
      DiscrError2["Mapping"] = "mapping";
    })(DiscrError || (exports.DiscrError = DiscrError = {}));
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var types_1 = require_types();
    var compile_1 = require_compile();
    var ref_error_1 = require_ref_error();
    var util_1 = require_util();
    var error = {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag: tag2, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag2}}`
    };
    var def = {
      keyword: "discriminator",
      type: "object",
      schemaType: "object",
      error,
      code(cxt) {
        const { gen, data, schema, parentSchema, it } = cxt;
        const { oneOf } = parentSchema;
        if (!it.opts.discriminator) {
          throw new Error("discriminator: requires discriminator option");
        }
        const tagName = schema.propertyName;
        if (typeof tagName != "string")
          throw new Error("discriminator: requires propertyName");
        if (schema.mapping)
          throw new Error("discriminator: mapping is not supported");
        if (!oneOf)
          throw new Error("discriminator: requires oneOf keyword");
        const valid = gen.let("valid", false);
        const tag2 = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
        gen.if((0, codegen_1._)`typeof ${tag2} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag: tag2, tagName }));
        cxt.ok(valid);
        function validateMapping() {
          const mapping = getMapping();
          gen.if(false);
          for (const tagValue in mapping) {
            gen.elseIf((0, codegen_1._)`${tag2} === ${tagValue}`);
            gen.assign(valid, applyTagSchema(mapping[tagValue]));
          }
          gen.else();
          cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag: tag2, tagName });
          gen.endIf();
        }
        function applyTagSchema(schemaProp) {
          const _valid = gen.name("valid");
          const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
          cxt.mergeEvaluated(schCxt, codegen_1.Name);
          return _valid;
        }
        function getMapping() {
          var _a;
          const oneOfMapping = {};
          const topRequired = hasRequired(parentSchema);
          let tagRequired = true;
          for (let i = 0; i < oneOf.length; i++) {
            let sch = oneOf[i];
            if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
              const ref = sch.$ref;
              sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
              if (sch instanceof compile_1.SchemaEnv)
                sch = sch.schema;
              if (sch === void 0)
                throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
            }
            const propSch = (_a = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a === void 0 ? void 0 : _a[tagName];
            if (typeof propSch != "object") {
              throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
            }
            tagRequired = tagRequired && (topRequired || hasRequired(sch));
            addMappings(propSch, i);
          }
          if (!tagRequired)
            throw new Error(`discriminator: "${tagName}" must be required`);
          return oneOfMapping;
          function hasRequired({ required }) {
            return Array.isArray(required) && required.includes(tagName);
          }
          function addMappings(sch, i) {
            if (sch.const) {
              addMapping(sch.const, i);
            } else if (sch.enum) {
              for (const tagValue of sch.enum) {
                addMapping(tagValue, i);
              }
            } else {
              throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
            }
          }
          function addMapping(tagValue, i) {
            if (typeof tagValue != "string" || tagValue in oneOfMapping) {
              throw new Error(`discriminator: "${tagName}" values must be unique strings`);
            }
            oneOfMapping[tagValue] = i;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/schema.json
var require_schema4 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/schema.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/schema",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/core": true,
        "https://json-schema.org/draft/2020-12/vocab/applicator": true,
        "https://json-schema.org/draft/2020-12/vocab/unevaluated": true,
        "https://json-schema.org/draft/2020-12/vocab/validation": true,
        "https://json-schema.org/draft/2020-12/vocab/meta-data": true,
        "https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
        "https://json-schema.org/draft/2020-12/vocab/content": true
      },
      $dynamicAnchor: "meta",
      title: "Core and Validation specifications meta-schema",
      allOf: [
        { $ref: "meta/core" },
        { $ref: "meta/applicator" },
        { $ref: "meta/unevaluated" },
        { $ref: "meta/validation" },
        { $ref: "meta/meta-data" },
        { $ref: "meta/format-annotation" },
        { $ref: "meta/content" }
      ],
      type: ["object", "boolean"],
      $comment: "This meta-schema also defines keywords that have appeared in previous drafts in order to prevent incompatible extensions as they remain in common use.",
      properties: {
        definitions: {
          $comment: '"definitions" has been replaced by "$defs".',
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          deprecated: true,
          default: {}
        },
        dependencies: {
          $comment: '"dependencies" has been split and replaced by "dependentSchemas" and "dependentRequired" in order to serve their differing semantics.',
          type: "object",
          additionalProperties: {
            anyOf: [{ $dynamicRef: "#meta" }, { $ref: "meta/validation#/$defs/stringArray" }]
          },
          deprecated: true,
          default: {}
        },
        $recursiveAnchor: {
          $comment: '"$recursiveAnchor" has been replaced by "$dynamicAnchor".',
          $ref: "meta/core#/$defs/anchorString",
          deprecated: true
        },
        $recursiveRef: {
          $comment: '"$recursiveRef" has been replaced by "$dynamicRef".',
          $ref: "meta/core#/$defs/uriReferenceString",
          deprecated: true
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/applicator.json
var require_applicator2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/applicator.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/applicator",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/applicator": true
      },
      $dynamicAnchor: "meta",
      title: "Applicator vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        prefixItems: { $ref: "#/$defs/schemaArray" },
        items: { $dynamicRef: "#meta" },
        contains: { $dynamicRef: "#meta" },
        additionalProperties: { $dynamicRef: "#meta" },
        properties: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          default: {}
        },
        patternProperties: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          propertyNames: { format: "regex" },
          default: {}
        },
        dependentSchemas: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          default: {}
        },
        propertyNames: { $dynamicRef: "#meta" },
        if: { $dynamicRef: "#meta" },
        then: { $dynamicRef: "#meta" },
        else: { $dynamicRef: "#meta" },
        allOf: { $ref: "#/$defs/schemaArray" },
        anyOf: { $ref: "#/$defs/schemaArray" },
        oneOf: { $ref: "#/$defs/schemaArray" },
        not: { $dynamicRef: "#meta" }
      },
      $defs: {
        schemaArray: {
          type: "array",
          minItems: 1,
          items: { $dynamicRef: "#meta" }
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json
var require_unevaluated2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/unevaluated",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/unevaluated": true
      },
      $dynamicAnchor: "meta",
      title: "Unevaluated applicator vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        unevaluatedItems: { $dynamicRef: "#meta" },
        unevaluatedProperties: { $dynamicRef: "#meta" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/content.json
var require_content = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/content.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/content",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/content": true
      },
      $dynamicAnchor: "meta",
      title: "Content vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        contentEncoding: { type: "string" },
        contentMediaType: { type: "string" },
        contentSchema: { $dynamicRef: "#meta" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/core.json
var require_core3 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/core.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/core",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/core": true
      },
      $dynamicAnchor: "meta",
      title: "Core vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        $id: {
          $ref: "#/$defs/uriReferenceString",
          $comment: "Non-empty fragments not allowed.",
          pattern: "^[^#]*#?$"
        },
        $schema: { $ref: "#/$defs/uriString" },
        $ref: { $ref: "#/$defs/uriReferenceString" },
        $anchor: { $ref: "#/$defs/anchorString" },
        $dynamicRef: { $ref: "#/$defs/uriReferenceString" },
        $dynamicAnchor: { $ref: "#/$defs/anchorString" },
        $vocabulary: {
          type: "object",
          propertyNames: { $ref: "#/$defs/uriString" },
          additionalProperties: {
            type: "boolean"
          }
        },
        $comment: {
          type: "string"
        },
        $defs: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" }
        }
      },
      $defs: {
        anchorString: {
          type: "string",
          pattern: "^[A-Za-z_][-A-Za-z0-9._]*$"
        },
        uriString: {
          type: "string",
          format: "uri"
        },
        uriReferenceString: {
          type: "string",
          format: "uri-reference"
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json
var require_format_annotation = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/format-annotation",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/format-annotation": true
      },
      $dynamicAnchor: "meta",
      title: "Format vocabulary meta-schema for annotation results",
      type: ["object", "boolean"],
      properties: {
        format: { type: "string" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/meta-data.json
var require_meta_data = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/meta-data.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/meta-data",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/meta-data": true
      },
      $dynamicAnchor: "meta",
      title: "Meta-data vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        title: {
          type: "string"
        },
        description: {
          type: "string"
        },
        default: true,
        deprecated: {
          type: "boolean",
          default: false
        },
        readOnly: {
          type: "boolean",
          default: false
        },
        writeOnly: {
          type: "boolean",
          default: false
        },
        examples: {
          type: "array",
          items: true
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/validation.json
var require_validation2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/validation.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/validation",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/validation": true
      },
      $dynamicAnchor: "meta",
      title: "Validation vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        type: {
          anyOf: [
            { $ref: "#/$defs/simpleTypes" },
            {
              type: "array",
              items: { $ref: "#/$defs/simpleTypes" },
              minItems: 1,
              uniqueItems: true
            }
          ]
        },
        const: true,
        enum: {
          type: "array",
          items: true
        },
        multipleOf: {
          type: "number",
          exclusiveMinimum: 0
        },
        maximum: {
          type: "number"
        },
        exclusiveMaximum: {
          type: "number"
        },
        minimum: {
          type: "number"
        },
        exclusiveMinimum: {
          type: "number"
        },
        maxLength: { $ref: "#/$defs/nonNegativeInteger" },
        minLength: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        pattern: {
          type: "string",
          format: "regex"
        },
        maxItems: { $ref: "#/$defs/nonNegativeInteger" },
        minItems: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        uniqueItems: {
          type: "boolean",
          default: false
        },
        maxContains: { $ref: "#/$defs/nonNegativeInteger" },
        minContains: {
          $ref: "#/$defs/nonNegativeInteger",
          default: 1
        },
        maxProperties: { $ref: "#/$defs/nonNegativeInteger" },
        minProperties: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        required: { $ref: "#/$defs/stringArray" },
        dependentRequired: {
          type: "object",
          additionalProperties: {
            $ref: "#/$defs/stringArray"
          }
        }
      },
      $defs: {
        nonNegativeInteger: {
          type: "integer",
          minimum: 0
        },
        nonNegativeIntegerDefault0: {
          $ref: "#/$defs/nonNegativeInteger",
          default: 0
        },
        simpleTypes: {
          enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
        },
        stringArray: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          default: []
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/index.js
var require_json_schema_2020_12 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var metaSchema = require_schema4();
    var applicator = require_applicator2();
    var unevaluated = require_unevaluated2();
    var content = require_content();
    var core = require_core3();
    var format = require_format_annotation();
    var metadata = require_meta_data();
    var validation = require_validation2();
    var META_SUPPORT_DATA = ["/properties"];
    function addMetaSchema2020($data) {
      ;
      [
        metaSchema,
        applicator,
        unevaluated,
        content,
        core,
        with$data(this, format),
        metadata,
        with$data(this, validation)
      ].forEach((sch) => this.addMetaSchema(sch, void 0, false));
      return this;
      function with$data(ajv, sch) {
        return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
      }
    }
    exports.default = addMetaSchema2020;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js
var require__ = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2020 = void 0;
    var core_1 = require_core();
    var draft2020_1 = require_draft2020();
    var discriminator_1 = require_discriminator();
    var json_schema_2020_12_1 = require_json_schema_2020_12();
    var META_SCHEMA_ID = "https://json-schema.org/draft/2020-12/schema";
    var Ajv20202 = class extends core_1.default {
      constructor(opts = {}) {
        super({
          ...opts,
          dynamicRef: true,
          next: true,
          unevaluated: true
        });
      }
      _addVocabularies() {
        super._addVocabularies();
        draft2020_1.default.forEach((v) => this.addVocabulary(v));
        if (this.opts.discriminator)
          this.addKeyword(discriminator_1.default);
      }
      _addDefaultMetaSchema() {
        super._addDefaultMetaSchema();
        const { $data, meta } = this.opts;
        if (!meta)
          return;
        json_schema_2020_12_1.default.call(this, $data);
        this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
      }
      defaultMeta() {
        return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
      }
    };
    exports.Ajv2020 = Ajv20202;
    module.exports = exports = Ajv20202;
    module.exports.Ajv2020 = Ajv20202;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = Ajv20202;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
      return validation_error_1.default;
    } });
    var ref_error_1 = require_ref_error();
    Object.defineProperty(exports, "MissingRefError", { enumerable: true, get: function() {
      return ref_error_1.default;
    } });
  }
});

// src/console-server.ts
import { randomBytes } from "node:crypto";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/console-app.ts
import { createHash as createHash2, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, readFileSync as readFileSync5, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join as join2, sep } from "node:path";

// src/console-demo.ts
import { createHash } from "node:crypto";

// src/boundaries-rule.ts
var TOPIC_MAX = 500;
var SHARED_DRIVE_MAX = 100;
var DOMAIN_MAX = 253;
var BOUNDARIES_MAX_ORGS = 10;
var BOUNDARIES_MAX_DRIVES = 10;
var BOUNDARIES_VERSION_MAX = 2 ** 31 - 1;
var GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
var DRIVE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
var TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u;
var DRIVE_NAME_FORBIDDEN_RE = /[/\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
var EDGE_SPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
var chars = (s) => [...s].length;
var trimText = (s) => s.replace(EDGE_SPACE_RE, "");
function topicOk(topic) {
  if (typeof topic !== "string") return false;
  const t = trimText(topic);
  return chars(t) >= 1 && chars(t) <= TOPIC_MAX && !TOPIC_FORBIDDEN_RE.test(topic);
}
var orgOk = (org) => typeof org === "string" && GITHUB_ORG_RE.test(org);
function domainOk(domain) {
  if (typeof domain !== "string" || domain.length > DOMAIN_MAX || !DRIVE_DOMAIN_RE.test(domain)) return false;
  return !/^[0-9]+$/.test(domain.slice(domain.lastIndexOf(".") + 1));
}
function driveNameOk(name) {
  return typeof name === "string" && chars(name) >= 1 && chars(name) <= SHARED_DRIVE_MAX && !DRIVE_NAME_FORBIDDEN_RE.test(name) && name === trimText(name) && name !== "." && name !== "..";
}
var versionOk = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= BOUNDARIES_VERSION_MAX;
function nextSince(prev, version, next) {
  const p = prev?.boundaries ? prev.since ?? null : null;
  const org = (o) => {
    const key = o.toLowerCase();
    return p && Object.prototype.hasOwnProperty.call(p.github_orgs, key) ? p.github_orgs[key] ?? version : version;
  };
  return {
    github_orgs: Object.fromEntries(next.github_orgs.map((o) => [o.toLowerCase(), org(o)])),
    drives: next.drives.map((d) => ({
      domain: d.domain,
      shared_drive: d.shared_drive,
      since: p?.drives.find((x) => x.domain === d.domain && x.shared_drive === d.shared_drive)?.since ?? version
    })),
    member_folders: next.member_folders ? p?.member_folders ?? version : null
  };
}

// src/exposed.ts
import { fileURLToPath } from "node:url";

// src/manifest.ts
var import_yaml = __toESM(require_dist(), 1);
var import__ = __toESM(require__(), 1);
import { readFileSync } from "node:fs";

// node_modules/.pnpm/re2js@2.8.6/node_modules/re2js/build/index.js
var RE2Flags = class RE2Flags2 {
  static FOLD_CASE = 1;
  static LITERAL = 2;
  static CLASS_NL = 4;
  static DOT_NL = 8;
  static ONE_LINE = 16;
  static NON_GREEDY = 32;
  static PERL_X = 64;
  static UNICODE_GROUPS = 128;
  static WAS_DOLLAR = 256;
  static LOOKBEHIND = 512;
  static MATCH_NL = RE2Flags2.CLASS_NL | RE2Flags2.DOT_NL;
  static PERL = RE2Flags2.CLASS_NL | RE2Flags2.ONE_LINE | RE2Flags2.PERL_X | RE2Flags2.UNICODE_GROUPS;
  static POSIX = 0;
  static UNANCHORED = 0;
  static ANCHOR_START = 1;
  static ANCHOR_BOTH = 2;
};
var PublicFlags = {
  CASE_INSENSITIVE: 1,
  DOTALL: 2,
  MULTILINE: 4,
  DISABLE_UNICODE_GROUPS: 8,
  LONGEST_MATCH: 16,
  LOOKBEHINDS: 512
};
var ASCII_SIZE = 128;
var ASCII_TO_UPPER = new Int32Array(ASCII_SIZE);
var ASCII_TO_LOWER = new Int32Array(ASCII_SIZE);
var MAX_BMP = 65535;
for (let i = 0; i < ASCII_SIZE; i++) {
  if (i >= 97 && i <= 122) ASCII_TO_UPPER[i] = i - 32;
  else ASCII_TO_UPPER[i] = i;
  if (i >= 65 && i <= 90) ASCII_TO_LOWER[i] = i + 32;
  else ASCII_TO_LOWER[i] = i;
}
var Codepoint = class {
  static CODES = /* @__PURE__ */ new Map([
    ["\x07", 7],
    ["\b", 8],
    ["	", 9],
    ["\n", 10],
    ["\v", 11],
    ["\f", 12],
    ["\r", 13],
    [" ", 32],
    ['"', 34],
    ["$", 36],
    ["&", 38],
    ["'", 39],
    ["(", 40],
    [")", 41],
    ["*", 42],
    ["+", 43],
    ["-", 45],
    [".", 46],
    ["0", 48],
    ["1", 49],
    ["2", 50],
    ["3", 51],
    ["4", 52],
    ["5", 53],
    ["6", 54],
    ["7", 55],
    ["8", 56],
    ["9", 57],
    [":", 58],
    ["<", 60],
    [">", 62],
    ["?", 63],
    ["A", 65],
    ["B", 66],
    ["C", 67],
    ["F", 70],
    ["P", 80],
    ["Q", 81],
    ["U", 85],
    ["Z", 90],
    ["[", 91],
    ["\\", 92],
    ["]", 93],
    ["^", 94],
    ["_", 95],
    ["`", 96],
    ["a", 97],
    ["b", 98],
    ["f", 102],
    ["i", 105],
    ["m", 109],
    ["n", 110],
    ["r", 114],
    ["s", 115],
    ["t", 116],
    ["v", 118],
    ["x", 120],
    ["z", 122],
    ["{", 123],
    ["|", 124],
    ["}", 125]
  ]);
  static toUpperCase(codepoint) {
    if (codepoint < ASCII_SIZE) return ASCII_TO_UPPER[codepoint];
    const s = String.fromCodePoint(codepoint).toUpperCase();
    const expectedLen = s.codePointAt(0) > MAX_BMP ? 2 : 1;
    if (s.length > expectedLen) return codepoint;
    const sOrigin = String.fromCodePoint(s.codePointAt(0)).toLowerCase();
    const originExpectedLen = sOrigin.codePointAt(0) > MAX_BMP ? 2 : 1;
    if (sOrigin.length > originExpectedLen || sOrigin.codePointAt(0) !== codepoint) return codepoint;
    return s.codePointAt(0);
  }
  static toLowerCase(codepoint) {
    if (codepoint < ASCII_SIZE) return ASCII_TO_LOWER[codepoint];
    const s = String.fromCodePoint(codepoint).toLowerCase();
    const expectedLen = s.codePointAt(0) > MAX_BMP ? 2 : 1;
    if (s.length > expectedLen) return codepoint;
    const sOrigin = String.fromCodePoint(s.codePointAt(0)).toUpperCase();
    const originExpectedLen = sOrigin.codePointAt(0) > MAX_BMP ? 2 : 1;
    if (sOrigin.length > originExpectedLen || sOrigin.codePointAt(0) !== codepoint) return codepoint;
    return s.codePointAt(0);
  }
};
var UnicodeRangeTable = class {
  /**
  * @param {Uint32Array | number[]} data
  * @param {boolean} isStride1
  */
  constructor(data, isStride1 = false) {
    this.data = data;
    this.isStride1 = isStride1;
    this.SIZE = isStride1 ? 2 : 3;
  }
  getLo(index) {
    return this.data[index * this.SIZE];
  }
  getHi(index) {
    return this.data[index * this.SIZE + 1];
  }
  getStride(index) {
    return this.isStride1 ? 1 : this.data[index * this.SIZE + 2];
  }
  get length() {
    return this.data.length / this.SIZE;
  }
};
var B64_MAP = /* @__PURE__ */ new Uint8Array(256);
for (let i = 0, b = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-"; i < 64; i++) B64_MAP[b.charCodeAt(i)] = i;
var decodeVLQ = (str) => {
  const res = [];
  let value = 0, shift = 0;
  for (let i = 0; i < str.length; i++) {
    let digit = B64_MAP[str.charCodeAt(i)];
    value |= (digit & 31) << shift;
    if ((digit & 32) === 0) {
      res.push(value);
      value = 0;
      shift = 0;
    } else shift += 5;
  }
  return res;
};
var decodeRanges = (str, isStride1) => {
  const res = decodeVLQ(str);
  const numRanges = isStride1 ? res.length / 2 : res.length / 3;
  const out = new Uint32Array(numRanges * 3);
  let current = 0, resIdx = 0;
  for (let i = 0; i < numRanges; i++) {
    current += res[resIdx++];
    out[i * 3] = current;
    current += res[resIdx++];
    out[i * 3 + 1] = current;
    out[i * 3 + 2] = isStride1 ? 1 : res[resIdx++];
  }
  return out;
};
var decodeOrbit = (str) => {
  const res = decodeVLQ(str);
  const map = /* @__PURE__ */ new Map();
  let currentKey = 0;
  for (let i = 0; i < res.length; i += 2) {
    currentKey += res[i];
    const zz = res[i + 1];
    const delta = zz >>> 1 ^ -(zz & 1);
    map.set(currentKey, currentKey + delta);
  }
  return map;
};
var LazyMap = class {
  constructor(initializer) {
    this.initializer = initializer;
    this.cache = /* @__PURE__ */ new Map();
  }
  has(key) {
    return key in this.initializer;
  }
  get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const fn = this.initializer[key];
    const val = fn ? fn() : null;
    this.cache.set(key, val);
    return val;
  }
};
var UnicodeTables = class {
  static _CASE_ORBIT = null;
  static get CASE_ORBIT() {
    if (!this._CASE_ORBIT) this._CASE_ORBIT = decodeOrbit("rCgCIgCY+rQI4QiCuuBLgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCCgCBgCBgCBgCBgCBgCBgCB+7OB-BB-BB-BB-BB-BBskQB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BC-BB-BB-BB-BB-BB-BB-BByHBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBDCBBBCBBBCBBCCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBCCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBxHBCBBBCBBBCBBB3SBmMBkNBCBBBCBBB8MBCBBB6MB6MBCBBC+EB0MB2MBCBBB6MB+MBiGBmNBiNBCBBBmKBikzCBmNBqNBkIBsNBCBBBCBBBCBBB0NBCBBB0NDCBBB0NBCBBByNByNBCBBBCBBB2NBCBBDCBBCwDFCBCBDBCBCBDBCBCBDBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBB9EBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBCCBCBDBCBBBhGBvDBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBjICCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBH2iVBCBBBlKBwiVB+jVB+jVBCBBBlMBqEBuEBCBBBCBBBCBBBCBBBCBBB+hVB4hVB8hVBjNB7MC5MB5MCzMC1MB+0yCE5MB20yCC9MBu2yCBwyyCBo0yCChNBlNBo0yCBu-UBi0yCDlNC6-UBpNDrNIu+UDzNCm0yCBzNE0yyCBzNBpEBxNBxNBtEG1NLqxyCBkxyCnFoFrBCBBBCBBDCBBEkIBkIBkICoHHsCCqCBqCBqCCgEC+DB+DBmkOBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCC+BBgCBgCBgCBgCBgCBgCBgCBgCBrCBpCBpCBpCBmjOB-BB8BB-BB-BBgEB-BB-BByBBqgOBsDB-BBtwBB-BB-BB-BBsBBgDBCB-BB-BB-BBeB-BB-BB61OB-BB-BB-DB9DB9DBQB7DBmCE9CBrDBPBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBrFB-EBOBnHB3FB-FCCBBBNBCBBCjIBjIBjIBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgFBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCB-BB-BB8kMB-BB6kMB-BB-BB-BB-BB-BB-BB-BB-BB-BBokMB-BB-BBkkMBkkMB-BB-BB-BB-BB-BB-BB-BB4jMB-BB-BB-BB-BB-BB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EB-EBCBBBCBoiMBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBJCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBeBCBBBCBBBCBBBCBBBCBBBCBBBCBBBdBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBCgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDL-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-C64CgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOBgmOCgmOGgmODg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FBg8FDg8FBg8FBg8FhVg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBg9rCBQBQBQBQBQBQDPBPBPBPBPBPjkC7mMB5mMBnmMBjmMBCBlmMB3lMBpiMBk8kCBCBBG-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FB-7FD-7FB-7FB-7F6FoglCEsuHRwjlCyDCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCB0DBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBG1DD97OCCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQBQBQBQBQDPBPBPBPBPBPDQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQBQBQBQBQDPBPBPBPBPBPEQCQCQCQCPCPCPCPBQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPB0EB0EBsFBsFBsFBsFBoGBoGBgIBgIBgHBgHB8HB8HDQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQBQBQBQBQBQBQBPBPBPBPBPBPBPBPBQBQCSFPBPBzEBzEBRCxnOFSFrFBrFBrFBrFBREQBQClkOFPBPBnGBnGFQBQCljOCODPBPB-GB-GBNHSF-HB-HB7HB7HBRqJ53OE9tQBrmQH4Bc3BSgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBgBBfBfBfBfBfBfBfBfBfBfBfBfBfBfBfBfECBByZ0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BB0BBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzBBzB34BgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDBgDB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CB-CBCBBBt-UBruHBt+UB1iVBviVBCBBBCBBBCBBB3hVB5-UB9hVB7hVCCBBCCBBI9jVB9jVBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBICBBBCBBECBBN-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOB-lOC-lOG-lOzoeCBBBCBBBCBBBCBBBCBBBCBl8kCBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBTCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBnECBBBCBBBCBBBCBBBCBBBCBBBCBBDCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBKCBBBCBBBnglCBCBBBCBBBCBBBCBBBCBBECBBBvyyCDCBBBCBBBgDCCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBn0yCB90yCB10yCBh0yCBn0yCCjxyCBzyyCBpxyCBg6BBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBB-CBl0yCBvjlCBCBBBCBBBt2yCBCBBBCBBBCBBBCBBBCBBBCBBBCBBBCBBBhkzCZCBB9a-5Bd-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCB-8rCm6TCBB7gBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCH-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BmlBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvChDwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCBwCFvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvCBvC1DuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCCuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCBuCCuCBuCBuCBuCBuCBuCBuCCuCBuCCtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCCtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCBtCCtCBtCBtCBtCBtCBtCBtCCtCBtCk2BgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEBgEO-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-DB-D+CgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCL-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-B74CgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BhrVgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCBgCB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BB-BhB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BB2BD1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BB1BtxekCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBkCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjCBjC");
    return this._CASE_ORBIT;
  }
  static _Print = null;
  static get Print() {
    if (!this._Print) this._Print = new UnicodeRangeTable(decodeRanges("hB9CBjBLBCpWBDFBFGBCCCBSBCsMBClBBDxBBDCBC2BBJaBFFBSVBC-FBCvBBD6BBDkDBP6BBDwBBDOBCbBDCCBJBGfBIqCBCgFBCHBDBBDVBCGBCEEBCBDIBDBBDDBJFFBCCBDBDYBDCBCFBFBBDVBCGBCBBCBBCBBDCCBDBFBBDCBEIIBCBCIIBPBLCBCIBCCBCVBCGBCBBCEBDJBCCBCCBDQQBCBDLBIGBCCBCHBDBBDVBCGBCBBCEBDIBDBBDCBICBFBBCEBDRBLBBCFBECBCDBEBBCCCBEEBEEBBBELBFEBECBCDBDHHPUBGMBCCBCWBCPBDIBCCBCDBIBBCCBCBBDDBDJBIVBCCBCWBCJBCEBDIBCCBCDBIBBGCBCDBDJBCCBNMBCCBCyBBCCBCFBFPBDZBCCBCRBEXBCIBCDDBFBEFFBEBCCCBGBHJBDCBN5BBFcBmBBBCCCBDBCXBCCCBVBDEBCCCBFBCJBDDBhBnCBCjBBFmBBCjBBCOBCMBmBlGBCGGD4LBCDBDGBCCCBCBDoBBCDBDgBBCDBDGBCCCBCBDOBC4BBCDBDiCBDfBEZBH1CBDFBD-TBCbBE4CBIVBKXBKTBNMBCCBCBBN9CBDJBHJBHNBCKBH4CBIqBBGlCBLeBCLBFLBFEEBoBBDEBMrBBFZBHKBE9BBDgCBCcBDKBHJBHNBDtBBDLBVsCBClFBJ7BBEOBE9BBGqBBDKBJqBBG1QBDFBDlBBDFBDHBCGCBdBD0BBCOBCNBDFBCSBDCBCIBSXBJuBBSBBDaBCMBEhBBPgBBQrEBF5UBXKBWz4BBD9LBGsBBCGGD3BBIBBPXBKGBCGBCGBCGBCGBCGBCGBCGBC9DBjBZBC4CBN1GBbPBC+BBC1CBDmDBGqBBC9CBC1CBKvBBCszcBE2BBK7KBV3FBJ8GBV7BBEJBH3BBJlCBJLBHzDBMdBEtCBCKBFgBBC2BBKNBDJBDmDBZbBLFBDFBDFBKGBCGBC7BBF9DBDJBHj9KBNWBFwBBloItLBDpDBnBGBNEBGZBCEBCCCBCCBCCBoUBhBpBBHyBBCSBCDBFEBCmEBF9FBEFBDFBDFBDCBEGBCGBOBBDLBCZBCSBCBBCOBDNBjB6DBGCBFsBBE3CBCMBEwBwBBsBBjEcBEwBBQbBFjBBKdBGqBBGdBCkBBFNBrB9EBDJBHjBBFjBBFnBBJzBBMLBCOBCGBCBBCKBCOBCGBCBBEzBBN2JBKVBLHBZFBCpBBCIBmCFBDCCBqBBCBBEDDBVBCnCBJIBxBSBCBBGgBBEaBGaBnB3BBFTBDxBBCBBGHBCCBCcBDCBFJBIIBI-BBhBmBBFLBK1BBEcBDaBGZBIDBNGBxCoCB4ByBBOyBBItBBJJBHlBBEcBJBBxGeBCpBBCCBDBBRFBJIBiBtBBJpBBXZBnBbBVWBKtCBFjBBK9BBCEBOYBIJBH0BBCRBJmBBK-CBCTBMRBCuBB-BGBCCCBCBCOBCKBH6BBGJBHDBCHBDBBDVBCGBCBBCEBCJBDBBDCBDHHGGBDGBEEBMJBCDDClBBCJBCDDCDBCJBCBBJBBe7CBCEBfnCBJJBnF1BBDlBBjBkCBMJBHMBU5BBHJBHTBdaBDOBFWB6F7BBlDyCBNHBDDDBGBCBBCdBCBBDLBKJBnCHBDtBBDKBcnCBJyCBOoCBIJB3CHB5ChBBPJBHIBCsBBCNBLcBEfBDVBCNBqCGBCBBCrBBECCBCCBHBJJBHFBCBBCkBBCBBCFBIJBHrBBFJB3HYBIQBCoBBEcB2CQQBwBBO6cBnDuDBCEBMjGBtyCiDBOvhBBRVBL68DBGmSB61G5BBn2B4RBIeBCJBFwCBCJBHdBDFBLlCBLJBCGBCUBGSBxN5BBnG6CBGYBDYBtBqCBF4BBIQBhCEBMGBK1mHBqBfBiDyDB+vIDBCGBCBBCiJBQeeBBBDPPBCBJrMBloCqDBGMBEIBIJBDDBh7D8HBEzNBHWBQQBQtBBDWBKzDB9B1HBLmBBDpCBJvDBWlCB7DTBNTBN2CBKYBoE0CBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDjJBD9VBQEBCOBxiBeBHFB2GGBCQBDGBCBBCEBG9BBiBxDxDBrBBENBDJBFBBhKeBS5BBGxOxOBoBB3GqBBFhGhGBdBCVBJBBhHGBCDBCBBCOBCkGBDPBqBrCBFJBFBByYjCBtC8BBjGDBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQB1BBBvIrBBFjDBNOBDOBCOBCkBBLtFB5BcBOrBBFIBIBBPFB7E4eBEQBEMBE5GBHLBFQQBKBF3BBJJBHnBBJdBDLBFBBPIBoB3KBJNBDMBEKBE4BBCFFBOBDLBFJBIyEBCmDBmgB-2pBBhB9oEBDt0FBDwpHBQtTBjtC9QBjvBq6EBGppIBnkzVvHB", false));
    return this._Print;
  }
  static CATEGORIES = new LazyMap({
    C: () => new UnicodeRangeTable(decodeRanges("AfBgDgBBOrWrWBHHBCBICCVuMuMnBBBzBBBE4B4BBGBcDBHQBXhGhGxBBB8BBBmDNB8BBByBBBQddBCCMEBhBGBsCiFiFJBBDBBXIICCBFBBKBBDBBFHBCDBDGGBaaBEEHDBDBBXIIDGDBCCGDBDBBECBCGBFCCBFBSJBEKKEXXIDDGBBLIEBCCBNBFBBNGBIEEJBBDBBXIIDGGBKKBDDBEEBFBEDBDGGBTTBIBDHHBBBEFFBBBDCCDCBDCBECBNDBGCBEFFBCCBEBCNBWEBOEEYRRBKKEFFBFBDEEDBBFBBLGBXEEYLLGBBKEEFGBDEBEFFBLLELBOEE0BEEHDBRBBbEETCBZKKCBBICBCDBHCCJFBLBBELB7BDBekBBDCCGZZCYYBGGCIILBBFfBpClBlBBCBoBlBlBQOOBjBBnGCCBDBCBB6LFFBIICFFBqBqBFBBiBFFBIICFFBQQ6BFFBkCkCBhBhBBBBbFB3CBBHBB+UCB6CGBXIBZIBVLBOEEDLB-CBBLFBLFBPMMBEB6CGBsBEBnCJBgBNNBCBNDBCCBrBBBGKBtBDBbFBMCB-BBBiCeeBMMBEBLFBPBBvBBBNTBuCnFnFBGB9BCBQCB-BEBsBBBMHBsBEB3QBBHBBnBBBHBBJGCgBBB2BQQPBBHUUBEEKMMBDBbEByBPBDBBcOOBBBjBNBiBOBtEDB7UVBMUB14BBB-LEBuBCCBDBCBB5BGBDNBZIBI4BI-DhBBb6C6CBKB3GZBxC3C3CBoDoDBDBsB-C-C3CIBxBuzcuzcBBB4BIB9KTB5FHB+GTB9BCBLFB5BHBnCHBNFB1DKBfCBvCMMBCBiB4B4BBHBPBBLBBoDXBdJBHBBHBBHIBIII9BDB-DBBLFBl9KLBYDByBjoIBvLBBrDlBBILBGEBbGGCGDrUfBrBFB0BUUFDBGoEoEBCB-FCBHBBHBBHBBECBIIIBLBDBBNbbUDDQBBPhBB8DEBEDBuBCB5COOBBBCuBBvBhEBeCByBOBdDBlBIBfEBsBEBfmBmBBCBPpBB-EBBLFBlBDBlBDBpBHB1BKBNQQIDDMQQIDDBBB1BLB4JIBXJBJXBHrBrBKkCBHBBCtBtBDCBCBBYpCpCBGBKvBBUDDBDBiBCBcEBclBB5BDBVBBzBDDBDBJEEeBBEDBLGBKGBhCfBoBDBNIB3BCBeBBcEBbGBFLBIvCBqC2BB0BMB0BGBvBHBLFBnBCBeHBDvGBgBrBrBEBBDPBHHBKgBBvBHBrBVBblBBdTBYIBvCDBlBIB-BGGBLBaGBLFB2BTTBGBoBIBhDVVBJBTwBwBB8BBICCFQQMFB8BEBLFBFJJBDDBXXIDDGLLBDDBEEBCCBEBCEBIBBICBGKBLCCBCCnBLLCBBCFFLDDBGBDcB9CGGBcBpCHBLlFB3BBBnBhBBmCKBLFBOSB7BFBLFBVbBcBBQDBY4FB9BjDB0CLBJBBCBBJDDfDDBNNBHBLlCBJBBvBBBMaBpCHB0CMBqCGBL1CBJ3CBjBNBLFBKuBuBPJBeCBhBBBXPPBnCBIDDtBCBCDDKHBLFBHDDmBDDHGBLFBtBDBL1HBaGBSqBqBBBBe0CBCOBzBMB8clDBwDGGBJBlGryCBkDMBxhBPBXJB88DEBoS41GB7Bl2BB6RGBgBLLBCByCLLBEBfBBHJBnCJBLIIWEBUvNB7BlGB8CEBaBBarBBsCDB6BGBS-BBGKBIIB3mHoBBhBgDB0D8vIBFIIDkJkJBNBCcBEBBCNBFHBtMjoCBsDEBOCBKGBLBBF-6DB+HCB1NFBYOBSOBvBBBYIB1D7BB3HJBoBBBrCHBxDUBnC5DBVLBVLB4CIBamEB2CoCoCDBBCBBDBBFNNCIIiCFFBJJIddFGGCCBI1K1KBlJlJB-V-VBNBGQQBuiBBgBFBH0GBISSBIIDGGBDB-BgBBCvDBuBCBPBBLDBD-JBgBQB7BEBCvOBrB1GBsBDBC-FBgBXXBGBD-GBIFFDQQmGBBRoBBtCDBLDBDwYBlCrCB+BhGBFccDCCBCCLFFCCCBEBCDBCECEDDCBBCICDCCBFFIKFCLLSEBEGGSzBBDtIBtBDBlDLBQBBQQQmBJBvF3BBeMBtBDBKGBDNBH5EB6eCBSCBOCB7GFBNDBCOBNDB5BHBLFBpBHBfBBNDBDNBKmBB5KHBPBBOCBMCB6BCCBCBRBBNDBLGB0EoDoDBjgBBh3pBfB-oEBBv0FBBypHOBvThtCB-QhvBBs6EEBrpIlkzVBxHvw-FB", false)),
    Cc: () => new UnicodeRangeTable(decodeRanges("AfgDgB", true)),
    Cf: () => new UnicodeRangeTable(decodeRanges("tFzqBzqBBEBXhGhGyBhMhMBxCxCs5D9-B9-BBDBbEByBEBCJBw03B6H6HBBBimEQQj7IPBhjiBDBwmFHBn0rYffB+CB", false)),
    Cn: () => new UnicodeRangeTable(decodeRanges("4bBBHDBICCVuMuMnBBBzBBBE4B4BBGBcDBHKBvI9B9BBmDmDBMB8BBByBBBQddBCCMEBjBEBuHJJBDDBXXICCBBBFBBKBBDBBFHBCDBDGGBaaBEEHDBDBBXIIDGDBCCGDBDBBECBCGBFCCBFBSJBEKKEXXIDDGBBLIEBCCBNBFBBNGBIEEJBBDBBXIIDGGBKKBDDBEEBFBEDBDGGBTTBIBDHHBBBEFFBBBDCCDCBDCBECBNDBGCBEFFBCCBEBCNBWEBOEEYRRBKKEFFBFBDEEDBBFBBLGBXEEYLLGBBKEEFGBDEBEFFBLLELBOEE0BEEHDBRBBbEETCBZKKCBBICBCDBHCCJFBLBBELB7BDBekBBDCCGZZCYYBGGCIILBBFfBpClBlBBCBoBlBlBQOOBjBBnGCCBDBCBB6LFFBIICFFBqBqBFBBiBFFBIICFFBQQ6BFFBkCkCBhBhBBBBbFB3CBBHBB+UCB6CGBXIBZIBVLBOEEDLB-CBBLFBLFBbFB6CGBsBEBnCJBgBNNBCBNDBCCBrBBBGKBtBDBbFBMCB-BBBiCeeBMMBEBLFBPBBvBBBNTBuCnFnFBGB9BCBQCB-BEBsBBBMHBsBEB3QBBHBBnBBBHBBJGCgBBB2BQQPBBHUUBEEKmDmDNBBcOOBBBjBNBiBOBtEDB7UVBMUB14BBB-LEBuBCCBDBCBB5BGBDNBZIBI4BI-DhBBb6C6CBKB3GZBxC3C3CBoDoDBDBsB-C-C3CIBxBuzcuzcBBB4BIB9KTB5FHB+GTB9BCBLFB5BHBnCHBNFB1DKBfCBvCMMBCBiB4B4BBHBPBBLBBoDXBdJBHBBHBBHIBIII9BDB-DBBLFBl9KLBYDByBDBvzIBBrDlBBILBGEBbGGCGDrUfBrBFB0BUUFDBGoEoEBCC-FCBHBBHBBHBBECBIIIBIBGBBNbbUDDQBBPhBB8DEBEDBuBCB5COOBBBCuBBvBhEBeCByBOBdDBlBIBfEBsBEBfmBmBBCBPpBB-EBBLFBlBDBlBDBpBHB1BKBNQQIDDMQQIDDBBB1BLB4JIBXJBJXBHrBrBKkCBHBBCtBtBDCBCBBYpCpCBGBKvBBUDDBDBiBCBcEBclBB5BDBVBBzBDDBDBJEEeBBEDBLGBKGBhCfBoBDBNIB3BCBeBBcEBbGBFLBIvCBqC2BB0BMB0BGBvBHBLFBnBCBeHBDvGBgBrBrBEBBDPBHHBKgBBvBHBrBVBblBBdTBYIBvCDBlBIBlCJBCBBaGBLFB2BTTBGBoBIBhDVVBJBTwBwBB8BBICCFQQMFB8BEBLFBFJJBDDBXXIDDGLLBDDBEEBCCBEBCEBIBBICBGKBLCCBCCnBLLCBBCFFLDDBGBDcB9CGGBcBpCHBLlFB3BBBnBhBBmCKBLFBOSB7BFBLFBVbBcBBQDBY4FB9BjDB0CLBJBBCBBJDDfDDBNNBHBLlCBJBBvBBBMaBpCHB0CMBqCGBL1CBJ3CBjBNBLFBKuBuBPJBeCBhBBBXPPBnCBIDDtBCBCDDKHBLFBHDDmBDDHGBLFBtBDBL1HBaGBSqBqBBBBe0CBCOBzBMB8clDBwDGGBJBlGryCBkDMB3iBJB88DEBoS41GB7Bl2BB6RGBgBLLBCByCLLBEBfBBHJBnCJBLIIWEBUvNB7BlGB8CEBaBBarBBsCDB6BGBS-BBGKBIIB3mHoBBhBgDB0D8vIBFIIDkJkJBNBCcBEBBCNBFHBtMjoCBsDEBOCBKGBLBBJ76DB+HCB1NFBYOBSOBvBBBYIB1D7BB3HJBoBBBjGUBnC5DBVLBVLB4CIBamEB2CoCoCDBBCBBDBBFNNCIIiCFFBJJIddFGGCCBI1K1KBlJlJB-V-VBNBGQQBuiBBgBFBH0GBISSBIIDGGBDB-BgBBCvDBuBCBPBBLDBD-JBgBQB7BEBCvOBrB1GBsBDBC-FBgBXXBGBD-GBIFFDQQmGBBRoBBtCDBLDBDwYBlCrCB+BhGBFccDCCBCCLFFCCCBEBCDBCECEDDCBBCICDCCBFFIKFCLLSEBEGGSzBBDtIBtBDBlDLBQBBQQQmBJBvF3BBeMBtBDBKGBDNBH5EB6eCBSCBOCB7GFBNDBCOBNDB5BHBLFBpBHBfBBNDBDNBKmBB5KHBPBBOCBMCB6BCCBCBRBBNDBLGB0EoDoDBjgBBh3pBfB-oEBBv0FBBypHOBvThtCB-QhvBBs6EEBrpIm8yVBCdBhD-DBxHvw-BB---BBB---BBB", false)),
    Co: () => new UnicodeRangeTable(decodeRanges("gg4B-nGh4hc9--BD9--B", true)),
    Cs: () => new UnicodeRangeTable(decodeRanges("gg2B--B", true)),
    L: () => new UnicodeRangeTable(decodeRanges("hCZBHZBwBLLFGGBVBCeBCpOBFLBPEBICCiEEBCBBDDBCHHCCBCCCBSBCyCBCqEBJlFBClBBDHHBnBBoCaBFDBuBqBBkBBBCiDBCQQBIIBLLBBBDRRCdBe4CBMZZBfBKBBFGGBUBFKKEYYBXBIKBGXBCGBRpBB7B1BBETTIJBQPBFHBDBBDVBCGBCEEBCBERROBBCCBPBBLJJBEBFBBDVBCGBCBBCBBCBBgBDBCUUBBBRIBCCBCVBCGBCBBCEBETTQBBYMMBGBDBBDVBCGBCBBCEBEffBCCBBBQSSCFBECBCDBEBBCCCBEEBEEBBBELBX1B1BBGBCCBCWBCPBEbbBBBCBBDBBfFFBGBCCBCWBCJBCEBEffBBBCBBQBBSIBCCBCoBBDRRGCBJCBZFBGRBEXBCIBCDDBFB7BvBBCBBNGB7BBBCCCBDBCXBCCCBIBCBBKDDBDBCWWBCBhBgCgCBGBCjBBcEB0DqBBVRRBEBFDBEEEBIIBBBFMBNSSBkBBCGGDqBBCsKBCDBDGBCCCBCBDoBBCDBDgBBCDBDGBCCCBCBDOBC4BBCDBDiCBmBPBR1CBDFBErTBDQBCZBGqCBHHBIRBOSBPRBPMBCCBQzBBkBFFkC4CBIEBDhBBCGGBkCBLeByBdBDEBMrBBFZB3BWBK0BBzC+C+CBtBBSHB3BdBOBBLrBBbjBBqBCBLjBBDKBGqBBDCBqBDBCFBCBBEGGB+FBhC1IBDFBDlBBDFBDHBCGCBdBD0BBCGBCEEBBBCGBEDBDFBFMBGCBCGB1DOORMBmDFFDJBCEEBDBHGCBCBCKBDDBGEBF1B1BB8zC8zCBjHBHDBEBBNlBBCGGD3BBIRRBVBKGBCGBCGBCGBCGBCGBCGBCGBxC2O2OBrBrBBDBGBBF1CBHCBC5CBCDBGqBBC9CBSfBxBPBhQ-tGBhCs0VBkCtBBDsIBEPBLBBVuBBReBDlCByBIBDmDBDxCBVQBCCBCDBCWBezBBPxBB-BFBECCBMMBaBLWBacBIuBBdRRBDBCJBLEBCoBBYCBCHBVWBEEEBwBBCEEBDDBDBDCCZCBDKBICBNFBDFBDFBKGBCGBCqBBCNBHyDBej9KBNWBFwBBloItLBDpDBnBGBNEBGCCBIBCMBCEBCCCBCCBCCBqDBiBqLBT-BBD1BBpBLB1DEBCmEBlBZBHZBM4CBEFBDFBDFBDCBkBLBCZBCSBCBBCOBDNBjB6DBmMcBEwBBwBfBOTBCHBHlBBLdBDjBBFHBxB9EBTjBBFjBBFnBBJzBBNKBCOBCGBCBBCKBCOBCGBCBBEzBBN2JBKVBLHBZFBCpBBCIBmCFBDCCBqBBCBBEDDBVBLWBKeBiCSBCBBLVBLZBHZBnB3BBHBBhCQQBCBCCBCcBrBcBEcBkBHBCbBc1BBLVBLSBORBvDoCB4ByBBOyBBOjBBnBbBKWB7HpBBHBBRFB5BcBLJJBUBrBRBvBUBcWBN0BB6BBBDOOBrBBhBYBbjBBeDDJiBBENNBuBBPDBWCCkBRBCYBUBBgCGBCCCBCBCOBCJBIuBBnBHBDBBDVBCGBCBBCEBETTNEBfJBCDDClBBCaaCtBtBBzBBTDBVCBfvBBVBBC5F5FBtBBqBDBlBvBBV8B8BBpBBOoCoCBZBmBGB6FrBB1D-BBgBHBDDDBGBCBBCXBQCC-CHBDmBBRCCdLLBmBBIWWMtBBUTTBnCBoGgBBgBIBCkBBSyByBBcBxDGBCBBClBBWaaBEBCBBCfBPYYBqBBlISBQCCBLBChBB9DwCwCB4cBnHjGBtyCgDBQvhBBSFBa68DBGmSB61GdBj3B4RBIeBSuCBSdBTvBBRDBgBUBGSBxNsBB0G-BBhBYBDYBtBqCBGjCjCBLBhCBBCPPBNNB0mHBqBfBiDyDB+vIDBCGBCBBCiJBQeeBBBDPPBCBJrMBloCqDBGMBEIBIJBn7F0CBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDYBCYBCeBCYBCeBCYBCeBCYBCeBCYBCHB15BeBHFBmI9BBzEsBBLGBRiKiKBcBTrBBlPbBlHdBDwGwGBdBCCBCBBCGBDEBKBBhHGBCDBCBBCOBCkGB8BjCBI1lB1lBBCBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQBlqE-2pBBhB9oEBDt0FBDwpHBQtTBjtC9QBjvBq6EBGppIB", false)),
    LC: () => new UnicodeRangeTable(decodeRanges("hCZBHZB7BLLBVBCeBCiGBCDBFvGBDZBhGDBDBBECBCHHCCBCCCBSBCyCBCqEBJlFBClBBKoBB44ClBBCGGDqBBDCBhV1CBDFBjkCKBGqBBDCBhCrBBgCMBChBBmD1IBDFBDlBBDFBDHBCGCBdBD0BBCGBCEEBBBCGBEDBDFBFMBGCBCGBmIFFDJBCEEBDBHGCBCBCFBFDDBCBGEBF1B1BB8zC8zCB6DBDmDBHDBEBBNlBBCGGzoetBBTbBnEtCBCWBEDBCsCBZBBE2Z2ZBpBBGIBIvCBh6TGBNEBqgBZBHZBmlBvCBhDjBBFjBB1DKBCOBCGBCBBCKBCOBCGBCBBk2ByBBOyBB+CVBLVB74C-BBhrV-BBhBYBDYBtpZ0CBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDYBCYBCeBCYBCeBCYBCeBCYBCeBCYBCHB15BJBCTBHFB2uCjCB", false)),
    Ll: () => new UnicodeRangeTable(decodeRanges("hDZB7BqBqBBWBCHBC2BCBQCBuBCDECBBBDCCDEEBFFDEEBBBDDDCCCDCCBCCDEECDDBDDBBBHGDCOCBSCBDDCEEC4BCBFBDDDBCCFICBjCBDZBiGCCEEEBBBTccBhBBCBBECBCWCBDBCGDB0B0BBuBBCgBCK0BCDMCBgDCxBoBBo6CqBBDCB5XFBjkCIBC2D2DBqBBgCMBChBBnD0ECBHBCgDCBHBJFBLHBJHBJFBLHBJHBJNBDHBJHBJHBJEBCBBHEEBBBCBBJDBDBBJHBLCBCBBzIEEBEEcKFDBBJDBF2B2Bs1CvBBCEEBGCFCCBCCBEBGiDCBIICFFNlBBCGG0oesBCUaCoEMCBBBC+BCBGBCCCDICFCCDCCBBBCSCGGGCMCFCCDOCbEE2ZqBBGIBIvCBh6TGBNEBqhBZBumBnBBpEjBB8EKBCOBCGBCBBk4ByBB+DVB75CfBhsVfB8BYBnqZZBbGBCRBbZBbDBCCCBFBCKBbZBbZBbZBbZBbZBbZBbZBbZBbbBdYBCFBbYBCFBbYBCFBbYBCFBbYBCFBC15B15BBIBCTBHFB4vChBB", false)),
    Lm: () => new UnicodeRangeTable(decodeRanges("wVRBFLBPEBICCmEGG-OnHnHlFBBuIBBFgBgBKEEhFoFoF1mBgEgE2R72B72BsDkTkTxOFBvF+BBOjBjBBjBByVOORMBg-CBByHgGgG2OsBsBBDBGiDiDB+C+CBBB34bjnBjnBBEBvIzDzDdBB6DIBxCYYpDDBEBB2OXXqEtDtDWBBoDDBKngVngVuBBBh-BFBCpBBCIB0sBhBhB2K04D04DnrTDB9PCBpBBBnRMBhCBBCPPB9-P9-PBCBCGBCBByhM9BBqGGBud0Q0QsSAB", false)),
    Lo: () => new UnicodeRangeTable(decodeRanges("qFQQhIFFBCBxGBB7ZaBFDBuBfBCJBkBBBCiDBCZZBLLBBBDRRCdBe4CBMZZBfBWVBrBYBIKBGXBCGBRoBB8B1BBETTIJBROBFHBDBBDVBCGBCEEBCBERROBBCCBPBBLJJBEBFBBDVBCGBCBBCBBCBBgBDBCUUBBBRIBCCBCVBCGBCBBCEBETTQBBYMMBGBDBBDVBCGBCBBCEBEffBCCBBBQSSCFBECBCDBEBBCCCBEEBEEBBBELBX1B1BBGBCCBCWBCPBEbbBBBCBBDBBfFFBGBCCBCWBCJBCEBEffBBBCBBQBBSIBCCBCoBBDRRGCBJCBZFBGRBEXBCIBCDDBFB7BvBBCBBNFB8BBBCCCBDBCXBCCCBIBCBBKDDBDBYDBhBgCgCBGBCjBBcEB0DqBBVRRBEBFDBEEEBIIBBBFMBNyDyDBnKBCDBDGBCCCBCBDoBBCDBDgBBCDBDGBCCCBCBDOBC4BBCDBDiCBmBPByDrTBDQBCZBGqCBHHBIRBOSBPRBPMBCCBQzBBpBkCkCBhBBC0BBIEBDhBBCGGBkCBLeByBdBDEBMrBBFZB3BWBK0BBxFuBBSHB3BdBOBBLrBBbjBBqBCBLdByDDBCFBCBBE7hB7hBBCB4-C3BBZWBKGBCGBCGBCGBCGBCGBCGBCGBoR2B2BF1CBJCCB4CBFGGBpBBC9CBSfBxBPBhQ-tGBhC0wUBC2jBBkCnBBJrIBFPBLBBjCyByBBkCBqFoDoDEGBCCBCDBCWBezBBPxBB-BFBECCBMMBaBLWBacBIuBBuBEBDIBLEBCoBBYCBCHBVPBCFBEEEBwBBCEEBDDBDBDCCZBBEKBIPPBEBDFBDFBKGBCGByEiBBej9KBNWBFwBBloItLBDpDBkCCCBIBCMBCEBCCCBCCBCCBqDBiBqLBT-BBD1BBpBLB1DEBCmEBqDJBCsBBDeBEFBDFBDFBDCBkBLBCZBCSBCBBCOBDNBjB6DBmMcBEwBBwBfBOTBCHBHlBBLdBDjBBFHBhEtCBjDnBBJzBB9CzBBN2JBKVBLHB5EFBDCCBqBBCBBEDDBVBLWBKeBiCSBCBBLVBLZBHZBnB3BBHBBhCQQBCBCCBCcBrBcBEcBkBHBCbBc1BBLVBLSBORBvDoCB4FjBBnBDBCxJxJBoBBHBBRCBCBB5BcBLJJBUBrBRBvBUBcWBN0BB6BBBDOOBrBBhBYBbjBBeDDJiBBENNBuBBPDBWCCkBRBCYBUBBgCGBCCCBCBCOBCJBIuBBnBHBDBBDVBCGBCBBCEBETTNEBfJBCDDClBBCaaCtBtBBzBBTDBVCBfvBBVBBC5F5FBtBBqBDBlBvBBV8B8BBpBBOoCoCBZBmBGB6FrBB0GHBDDDBGBCBBCXBQCC-CHBDmBBRCCdLLBmBBIWWMtBBUTTBnCBoGgBBgBIBCkBBSyByBBcBxDGBCBBClBBWaaBEBCBBCfBPYYBnBBCBBlISBQCCBLBChBB9DwCwCB4cBnHjGBtyCgDBQvhBBSFBa68DBGmSB61GdBj3B4RBIeBSuCBSdBTvBB0BUBGSB0NnBB2MqCBGwFwFB0mHBqBfBiDyDBuwIiJBQeeBBBDPPBCBJrMBloCqDBGMBEIBIJBxzI2P2PBrBBiBiKiKBcBTrBBlPaBmHdBDwGwGBdBCCBCBBCGBDEBKiHiHBFBCDBCBBCOBCkGB8pBDBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQBlqE-2pBBhB9oEBDt0FBDwpHBQtTBjtC9QBjvBq6EBGppIB", false)),
    Lt: () => new UnicodeRangeTable(decodeRanges("lOGDnB2sH2sHBGBJHBJHBNQQwBAB", false)),
    Lu: () => new UnicodeRangeTable(decodeRanges("hCZBmDWBCGBiB2BCDOCDuBCBECEBBCCCBCCBBBDDBCBBCCBEBBCBBCECBCCDCCBCCBBBCCCBEEIJDCMCDQCDDDCCBC4BCIBBCBBDCCBCBCGCiJCCEJJHCCBBBCCCBCCBPBCIBkBDDBBBEWCGDDCBBDyBBxBgBCK2BCBMCD+CCDlBBq6ClBBCGGzW1CB0kCHHBpBBDCBhK0ECKgDCKHBJFBLHBJHBJFBMGCJHBpCDBNDBNDBNEBMDBnIFFECBDCBDEEBDBHGCBCBDDBLBBG+B+B9zCvBBxBCCBBBDGCBCBCDDJCBCgDCJCCFuqeuqeCqBCUaCoEMCE8BCLECBICFCCDCCEUCBDBCEBCOCBCBCCCBQCZs5Vs5VBYBmmBnBBpEjBB9EKBCOBCGBCBBr3ByBB+EVB75CfBhsVfBhCYBoqZZBbZBbZBbCCBGDBDDBCBCHBbZBbBBCDBDHBCGBcBBCDBCEBCEEBFBcZBbZBbZBbZBbZBbZBfYBiBYBiBYBiBYBiBYBiB2pE2pEBgBB", false)),
    M: () => new UnicodeRangeTable(decodeRanges("gYvDB0IGBoIsBBCCCBCCBCCpCKBxBUBRmDmDBFBDFBDBBCDBkBffBZB8CKB7BIBKZZBCBCIBCCBCEBsBCB8BIBrBXBCgBB3BCBCRBCGBLBBeCB5BCCBFBDBBDCBKLLBbbDCB5BCCBDBFBBDCBEffBEEMCB5BCCBGBCCBCCBVBBXFBCCB5BCCBFBDBBDCBICBLBBf8B8BBDBECBCDBKpBpBBDB4BCCBFBCCBCDBIBBMBBeCB5BCCBFBCCBCDBIBBMBBQNNBCB4BBBCGBCCBCDBKLLBeeBBBnCFFBEBCCCBGBTBB+BDDBFBNHBjDDDBHBMGBqCBBcECFBByBTBCBBGKBCjBBKlDlDBSBYDBFCBCCBDGBEDBOLBCLLBCBgWCBzdDBdCBeBBfBBhCfBKuBuBBBBC2D2DBjBjB3DLBFLB8GEB6BJBCcBDxBxBBsBBDLBVEBwBQBnBIBNCBfMB5BNBxBTB5ECBCUBFHHDCBnG-BBxWgBB--CCBuEhDhDBeBrRFBqDBB1udDBCJBhBBBxCBBxIEEFYYBDBF0C0CBzBzBBQBbRBOnBnBBGBaMBtBDBwBNBlBkCkCBMBNJJBuBuBBBBzBCCBBBDBBGBBCqBqBBDBGBBtHHBCBBx5TiXiXBOBRPBuejHjH2EEBn0BCBCBBGDBpBCBFmFmFB+R+RBCBiCEB+JBBuCFBnCKByBDB7DCB2BOBqBDDBLLBCBuBKBI+B+BBBBlBNBRBBtBNNBBBxBNBJDBCBB9CLBHDD+ELBWDB4BBBCGBDBBDCBKLLBDDBFBEEBkCIBCDDCDBCEBCPPBzCzCBQBYyCyCBSBsHGBDIBcBBzCQBrDMBmDOBhIOB2HFBCBBDDBCCCBuEuEBFBDGBEddBIBpBGBCDBJKKBJBvBPBnGHBoGHBCHBzCVBCNB7DFBECCBCCBFBCjCjCBDBCBBCEB8KDBKBBCxBxBBFBEEBYmnFmnFHOBpmLRBhuCEB8BGB5gBCCB1BBIDByCMMBslTslTBizEizEBsBBDWB-QEBEFBJHBDGBfDB1ECB89B2BBFxBBJPPXEBCOBxqBGBCQBDGBCBBCEBlDhFhFBFB4L+B+BBCB9PDB-HBB0HDDIBBG7O7OBFBuDGB29lYvHB", false)),
    Mc: () => new UnicodeRangeTable(decodeRanges("joC4B4BDCBJDBCBBzBBB7BCBHBBDBBLsBsB7BCBjC7B7BBBBJCCB2B2BB7B7BCHHBDDBLLnDBBCBBECBCCBLqBqBBBB+BDB+BBB7BCCBDBDBBCBBKBBdPPB7B7BBBBGCBCCBLrBrBBsCsCBBBHHBTBBrKBBgCsFsFBFFHDDBaaBLLBBBDGBWBBDFBDLLBBB5zBffiEIIBGBCBB7KDBDCBFBBCFBhHBB7BCCKCCBJJBEByExBxBGCCBDBCBB+BffFBBD9B9BDCBCEEBxBxBBGBJBBsFWW35EBB0-dBBD5C5CBzBzBBOBvEBBwBxBxBBFFBDDBBBvDBBDBBZuBuBCuDuDDBBGuHuHBCCBCCBCC0gZCCgEuBuBBBBFBB0DZZB8B8BxBCBKBBO+C+CBBBEBBCrFrFBBBgBBB7BBBCDBDBBDCBKLLB1C1CBBBIDDCDBCBBCmDmDBBBJBBErDrDBBBHCCBCBDuHuHBBBHDBDyDyDBBBJBBCuDuDCBBHoDoDCBBFmImIBBBK4H4HBEBCBBFDDCvEvEBBBJDBF1C1CeBB-BqGqGECCoGPPrDIID2G2GBDBFBBC-K-KBNNxBBBJBBCpvQpvQBBBlxD2BBpDBB0rYBBHFB", false)),
    Me: () => new UnicodeRangeTable(decodeRanges("okBBB1xF-wB-wBBCBCCBsshBCB", false)),
    Mn: () => new UnicodeRangeTable(decodeRanges("gYvDB0IEBqIsBBCCCBCCBCCpCKBxBUBRmDmDBFBDFBDBBCDBkBffBZB8CKB7BIBKZZBCBCIBCCBCEBsBCB8BIBrBXBCfB4BCCFHBFEEBFBLBBe7B7BFDBJVVBbbDBB6BFFBFFBDDBBBEffBEEMBB6BFFBDBCBBFVVBXXBEBC7B7BDCCBCBJIIBMMBff+BNNzBEE4BCCBBBGCBCDBIBBMBBe7B7BDHHGBBVBBdBB6BBBFDBJVVBeepCIIBBBC7C7CDGBNHBjDDDBHBMGBqCBBcEC4BNBCEBCBBGKBCjBBKnDnDBCBCFBCBBDBBaBBFCBRDBODDBHHQgWgWBBBzdCBeBBfBBfBBhCBBCGBJDDBJBKuBuBBBBC2D2DBjBjB3DCBFBBKHHBBB8GBBD7B7BCGBCCCDHBHJBDxBxBBMBCeBDLBVDBxBCCBDBCGGpBIBNBBhBDBDBBCCB5BCCBEECCB7BHBDBB5ECBCMBCGBFHHEBBnG-BBxWMBFEEBKB--CCBuEhDhDBeBrRDBsDBB1udFFBIBhBBBxCBBxIEEFaaBGG4EBBbRBOnBnBBGBaKBvBCBxBDDBCBDBBoBkCkCBEBDBBDBBNJJwB0B0BCCBDBBGBBCrBrBBJJvHDDFx5Tx5TiXPBRPBuejHjH2EEBn0BCBCBBGDBpBCBFmFmFB+R+RBCBiCEB+JBBuCFBnCKByBDB8D3B3BBNBqBDDBLLBBByBDBDBBI+B+BBBBlBEBCHB-BNNB1B1BBHBLDBDgDgDBBBDCCBHHD+E+EEHBWBB6BBBEmBmBBFBEEBnCFBOECPBB2CHBDCBCYY1CFBCFFBCCBvHvHBCBHBBCBBcBB2CHBDCCBrDrDCDDBEBCmDmDCDDBCBCEBkIIBCBBhIBBCFFxEDBDBBFhBhBBIBpBFBDDBJKKBEBDCBvBMBCBBnGCCBBBCqGqGBFBCFBCzCzCBUBDGBCBBCBB7DFBECCBCCBFBCpCpCBEEC8K8KBMMB1B1BBDBGCCYmnFmnFHOBpmLLBECBhuCEB8BGB5gBgCgCBCByC5lT5lTBizEizEBsBBDWBhRCBSHBDGBfDB1ECB89B2BBFxBBJPPXEBCOBxqBGBCQBDGBCBBCEBlDhFhFBFB4L+B+BBCB9PDB-HBB0HDDIBBG7O7OBFBuDGB29lYvHB", false)),
    N: () => new UnicodeRangeTable(decodeRanges("wBJB5DBBGDDBBBitBJBnEJBnGJB9MJB3DJBFFBtDJB3DJB3DJBDFBvDMB0DJBJGBoDJBpDGBISBuDJBhDJB3DJBnCTBtIJBnCJBwWTBybCBwHJBHJBXJBtJJBhEKBmFJBHJB3FJB3CJBnEJBHJB3gBEEBEBHJBnGyBBDEB3W7BBvCVB3TdBqrBqYqYaIBPCB4KDBrEJBfHBCOBhBJBoBOBh7cJB9FJBhKFB7EJBnBJBnGJBXJB3CJB3MJB34UJBuPsBBN4BBSBB2KaBlBDBeJJnEEBrGJBvdHBaGBoBIBsCEBXFBhFBBDPBDtBBhCIB1BBBfCBsCEBpDHBZHBqBGBrKFBxBJBHJB3IeB-EJBrBDBxDGBnEdBhEJB9BJBxEJBITB8HJB3KJB3DJB3LJBnDJBHTBtCLBlNSB+CJB3UJB3CcBkHJBnCJB3BJBnLJBnDUBshBuDBimPJBnpCJB3CJBnEJBCGBvQJBnIWB+KCB6nXJBnuBTBNTBtDYB2iBxBBhqCJBnNJB3PJB4HJBtWIBhEJB4Y6BBCCBCDBtCsBBCOBjeMBk3CJB", false)),
    Nd: () => new UnicodeRangeTable(decodeRanges("wBJnxBJnEJnGJ9MJ3DJ3DJ3DJ3DJ3DJ3DJ3DJ3DJ3DJhDJ3DJnCJ3IJnCJn6BJnBJtJJhEJnFJHJ3FJ3CJnEJHJnuiBJnVJnBJnGJXJ3CJ3MJ34UJnsBJnkCJHJ9YJhEJ9BJxEJ3IJ3KJ3DJ3LJnDJHTtCJnNJnDJ3UJ3CJ3HJnCJ3BJnLJ3uQJnpCJ3CJnEJ3QJ37XJ12CxBhqCJnNJ3PJ4HJ2aJ30EJ", true)),
    Nl: () => new UnicodeRangeTable(decodeRanges("u3FCBwzCiBBDDB-zDaaBHBPCBs1dJBxyW0BBtOJJnEEBrhIuDBm8SCB", false)),
    No: () => new UnicodeRangeTable(decodeRanges("yFBBGDDBBB2pCFB5LFB5DCBmEGB6GGBSIByNJB2hBTB0jBJBhP20B20BEFBHJBnGPBqB3W3WB6BBvCVB3TdBqrB1kB1kBBCBrEJBfHBCOBhBJBoBOBxrdFBymWsBBiCDBSBB2KaBlBDB1pBHBaGBoBIBsCEBXFBhFBBDPBDtBBhCIB1BBBfCBsCEBpDHBZHBqBGBrKFBhLeB-EJBrBDBxDGBnETB8LTBmqBBBvNIBobSB0aUBn8SGB-YWBqhZTBNTBtDYBvqFIBid6BBCCBCDBtCsBBCOBjeMB", false)),
    P: () => new UnicodeRangeTable(decodeRanges("hBCBCFBCDBLBBEBBbCBCccCkBkBGEELBBEEE-VJJzOFBqBBB0BCCDDDtBBBVBBCBBOCCBBBrCDBnDsBsBBMBqHCB3BOBgBmImIBLLtE5D5D6DnMnMNwLwL7CLLBpFpFBNBCmBmBBCBoCrCrCBDBFBBwDFBsFlTlTBHB4EuTuTtBBBvCCBoCBB+ECBCCBmBKB6JBB5GBBhEGBCFBhFBBLGBdCB9DDB8BEB-BBBhCHBM9Z9ZBWBJTBCMBCLBfBBPBB6TDBeBB+hBNBwCBBgBJB0MVBgCDBhBBB8XDBCBBxDwEwEBtBBCfBDLBkNCBFJBDLBRNNjD7C7CjgdBBuICBkDLL0DFB9LDB3CBBpBCBCyByBBwBwBiDMBRBB9DDB-DBBRBB6HzqUzqUBxGxGBIBXiBBCNBCFFCBB2ECBCFBCDBLBBEBBbCBCccCCCBFB7MCB9UxBxB-MoXoXoGgBgBxIIBnBxDxDBFBjCGB6CDByO-J-JjBlElEBDBtBDB+FGBuDBBCDB-DDBxBBBwCDBFOOCCB5CFBsDrJrJBCCBzDzDBDBLBBCpDpD7HWBqDCBdMBtCjEjEBBB9HpIpIBBB8E9C9CBGB0CCBCEB+CJB4GgDgDBDBrBBBmUBBrCMBwFxjBxjBBDB97CBB8zOBBmEiCiCBDBJpRpRBBBoJDBoK9lT9lTovHEB07C-a-aBAB", false)),
    Pc: () => new UnicodeRangeTable(decodeRanges("-Cg-Hg-HBUU-u3BBBZCBwHAB", false)),
    Pd: () => new UnicodeRangeTable(decodeRanges("tB9qB9qB0BiyDiyDmgBqgCqgCBEBiwDDDgBBBFdd-NUUwDxszBxszBBmBmBLqFqFhzD-J-J", false)),
    Pe: () => new UnicodeRangeTable(decodeRanges("pB0B0BgB+1D+1DC-6B-6BqtC4B4BQ7T7TCff-hBMCxChBhBCGC1MUChCCCiBmhBmhBCECtBGCtNICEGCDBB-ozB6G6GeOCESSCCCrF0B0BgBGD", false)),
    Pf: () => new UnicodeRangeTable(decodeRanges("7F+6H+6HEddpuDCCFDDQEE", false)),
    Pi: () => new UnicodeRangeTable(decodeRanges("rFt7Ht7HDBBDaapuDCCFDDQEE", false)),
    Po: () => new UnicodeRangeTable(decodeRanges("hBCBCCBDECBLLBEEBcclCGGPBBI-V-VJzOzOBEBqB3B3BDDDtBBBVBBCBBOCCBBBrCDBnDsBsBBMBqHCB3BOBgBmImIBLLtE5D5D6DnMnMNwLwL7CLLBpFpFBNBCxDxDrCEBFBBwDFBsFlTlTBHBmY9D9DBBBoCBB+ECBCCBmBFBCDB6JBB5GBBhEGBCFBhFBBLGBdCB9DDB8BEB-BBBhCHBMjajaBJJBGBJIBDDBDCBEKBCCCBIB7kDDBCBBxDwEwEBFFBBBDDDBHBCBBCDDBLLBDBCJBDDBCCCBLBDCBtNCB6B+F+FjgdBBuICBkDLL0DFB9LDB3CBBpBCBCyByBBwBwBiDMBRBB9DDB-DBBRBB6HlxUlxUBFBDXXVBBDDBECBCDBICBHCCB2E2EBBBCCBDECBLLBEEBcclBDDB7M7MBBB9UxBxB-MoXoXoGgBgBxIIBnBxDxDBFBjCGB6CDB0ZlElEBDBtBDB+FGBuDBBCDB-DDBxBBBwCDBFOOCCB5CFBsDrJrJBCCBzDzDBDBLBBCpDpD7HWBqDCBdMBtCjEjEBBB9HpIpIBBB8E9C9CBGB0CCBCEB+CJB4GgDgDBDBrBBBmUBBrCMBwFxjBxjBBDB97CBB8zOBBmEiCiCBDBJpRpRBBBoJDBoK9lT9lTovHEB07C-a-aBAB", false)),
    Ps: () => new UnicodeRangeTable(decodeRanges("oBzBzBgB-1D-1DC-6B-6B-rCEEnB4B4BQ7T7TCff-hBMCxChBhBCGC1MUChCCCiBmhBmhBCECaTTCECtNICEGCDipzBipzB4GeeCMCESSCCCrFzBzBgBEEDAB", false)),
    S: () => new UnicodeRangeTable(decodeRanges("kBHHRCBgBCCcCCkBEBCBBDCCBCBDEEfgBgBrODBNNBGGBCCCBPB2DPPBxDxDsErIrIBBB3DCBDDDBvGvGLUUB4H4HIBBpEqLqLBHHB2H2H-DjEjEBGBlEwGwGqBmGmGiGCBQCCBBBDFBVECmEHBCFBCBBGDBmGBBxXJB0WuLuLlL+E+EBgBBiLJBKIBhiBCCBBBMCBOCBOCBOBBmCOOoBCBOCBUhBB-BBBCDBCBBLCCBBBGFBCECFMMBFFBDBGDBC7B7BBFFB2LBFcBD+HBXKByCtCBXnTBtBwBBDeBLyMBX+BBFfBD1LBDpEBmHFBmLBBvBZBC4CBN1GBbPBFOOBNNWBBHBB8CBB0HBBFJBhBlBBKRRBdBMdBJQQBeBLmBBQ-JBhuG-BBx0V2BB6RWBKBBoDBB+EDBLDB+RCBiHPPB+9T+9TpEgBBuLPBhCBB3BHBtBDBjDCCBBBD7E7EHRRBBBgBCCcCCiEGBCGBOBB6JIB6BQBDCBCMBEwBwBBrBB7zBBBwSmWmWBiKiKBGBnjC2kC2kCBbBr6SDBG3qU3qUk7DvHBLCBEzNBHWBQQBgDzDB9B1HBLmBBD7BBGCBXBBIdBF8BBWhCBE7F7FB1CBrbaagBaagBaagBaagBaa9B-PB4BDBzBHBCNBCBBp2BwNwNttCEE+DiOiOBvIvIBqBBFjDBNOBDOBCOBCkBBYgFB5BcBOrBBFIBIBBPFB7E4eBEQBEMBE5GBHLBFQQBKBF3BBJJBHnBBJdBDLBFBBPIBoB3KBJNBDMBEKBE4BBCFFBOBDLBFJBIyEBC7CBLAB", false)),
    Sc: () => new UnicodeRangeTable(decodeRanges("kB+D+DBCBqnB8D8DzPBBzPBBI2H2HoImSmS8sClmClmCBgBB37hBkuVkuVtD7E7E8GBBEBB3-HDB-4wBxtCxtC", false)),
    Sk: () => new UnicodeRangeTable(decodeRanges("+CCCoCHHFEEqQDBNNBGGBCCCBPB2DPPBjoBjoB15FCCBBBMCBOCBOCBOBB9kEBBkzdWBKBBoDBBxePPBniUniUBPB8bCCjF4g9B4g9BBDB", false)),
    Sm: () => new UnicodeRangeTable(decodeRanges("rBRRBBB+BCCuBFFmBgBgB-XwQwQBBB8xGOOoBCBOCBsEoBoBBDBHlClCBDBGBBFGDIgBgBBDDCgBgBBqIBhBBB7CffBXBpBFB2OKK3BHBwDxKxKBDBDeBLPBhIiEBX+BBFfBDhIBxBUBDFB9+zB5Z5ZCCBlFRRBBB+BCCkEHHBCBitDBBhrwBx+Bx+BagBgBagBgBagBgBagBgBat5Ft5FB-uC-uCBHB", false)),
    So: () => new UnicodeRangeTable(decodeRanges("mFDDFCCyerIrIBgEgEBvGvGLUUB4H4HkQ2L2LjEFBClElEwGqBqBoMCBQCCBBBDFBVECmEHBCFBCBBGDBmGBBxXJB0WzWzW+EhBBiLJBKIBksBBBCDBCBBLCCBHHBEBCECFMMBPPCBBC7B7BBKKBDBDDBCBBCBBCGBCeBDBBCCCBdBtIHBFTBDGBDwCBCdBanBBHnCBXKByCtCBX2FBCIBC1BBJuDBC3HBtBrBBhC-HBhQvBBWBBHmBBDpEBmHFBmLBBvBZBC4CBN1GBbPBFOOBNNWBBHBBxKBBFJBhBlBBKRRBdBMdBJQQBeBLmBBQ-JBhuG-BBx0V2BBibDBLBBC+R+RBBBqqUPBuLPBhCBB3BHBuBCBlPEEFBBOBB6JIB6BQBDCBCMBEwBwBBrBB7zBBBwSpgBpgBBGBnjC2kC2kCBGBFQBr6SDBG3qU3qUk7DvHBLCBEzNBHWBQPBhDzDB9B1HBLmBBD7BBGCBXBBIdBF8BBWhCBE7F7FB1CBqlB-PB4BDBzBHBCNBCBBp2B96C96CiEyWyWBqBBFjDBNOBDOBCOBCkBBYgFB5BcBOrBBFIBIBBPFB7E6HBG4WBEQBEMBE5GBHLBFQQBKBF3BBJJBHnBBJdBDLBFBB-B3KBJNBDMBEKBE4BBCFFBOBDLBFJBIyEBC7CBLAB", false)),
    Z: () => new UnicodeRangeTable(decodeRanges("gBgEgEgvFgsCgsCBJBeBBGwBwBh9DAB", false)),
    Zl: () => new UnicodeRangeTable(decodeRanges("ohIA", true)),
    Zp: () => new UnicodeRangeTable(decodeRanges("phIA", true)),
    Zs: () => new UnicodeRangeTable(decodeRanges("gBgEgEgvFgsCgsCBJBlBwBwBh9DAB", false)),
    ASCII_Hex_Digit: () => new UnicodeRangeTable(decodeRanges("wBJIFbF", true)),
    Alphabetic: () => new UnicodeRangeTable(decodeRanges("hCZBHZBwBLLFGGBVBCeBCpOBFLBPEBICC3CeeBQBCBBDDBCHHCCBCCCBSBCyCBCqEBJlFBClBBDHHBnBBoBNBCCCBCCBCCJaBFDBeKBG3BBCGBPlDBCHBFHBFCBLCBDRRBuBBOkDBZgBBKBBFGGBWBDSBUYBIKBGXBCGBIJJBoBBLLBEGBHrCBCPBCCBFOBOSBCHBDBBDVBCGBCEEBCBEHBDBBDBBCJJFBBCEBNBBLFFBBBCFBFBBDVBCGBCBBCBBCBBFEBFBBDBBFIIBCBCSSBEBMCBCIBCCBCVBCGBCBBCEBEIBCCBCBBEQQBCBWDBFCBCHBDBBDVBCGBCBBCEBEHBDBBDBBKBBFBBCEBORRBCCBEBECBCDBEBBCCCBEEBEEBBBELBFEBECBCCBEHHpBMBCCBCWBCPBEHBCCBCCBJBBCCBCBBDDBdDBCHBCCBCWBCJBCEBEHBCCBCCBJBBGCBCDBOCBNMBCCBCoBBDHBCCBCCBCGGBCBIEBXFBCCBCRBEXBCIBCDDBFBJFBCCCBGBTBBO5BBGGBH0B0BBECBDBCXBCCCBRBCCBDEBCHHPDBhBgCgCBGBCjBBFSBFPBCjBBkC2BBCDDBDBR-BBLDBDlBBCGGDqBBCsKBCDBDGBCCCBCBDoBBCDBDgBBCDBDGBCCCBCBDOBC4BBCDBDiCBmBPBR1CBDFBErTBDQBCZBGqCBEKBITBMUBNTBNMBCCBCBBNzBBDSBPFFkC4CBIqBBGlCBLeBCLBFIBYdBDEBMrBBFZB3BbBF+BBDTBzBYYBMMBBByBzBBCOBCHB0BpBBDDBLrBBCKBP2BBXCBLjBBDKBGqBBDCBqBDBCFBCBBEGGB+FBUhBBM1IBDFBDlBBDFBDHBCGCBdBD0BBCGBCEEBBBCGBEDBDFBFMBGCBCGB1DOORMBmDFFDJBCEEBDBHGCBCBCKBDDBGEBFSSBnBBuZzBB34BkHBHDBEBBNlBBCGGD3BBIRRBVBKGBCGBCGBCGBCGBCGBCGBCGBCfBwB2O2OBBBaIBIEBDEBF1CBHCBC5CBCDBGqBBC9CBSfBxBPBhQ-tGBhCs0VBkCtBBDsIBEPBLBBVuBBGHBEwDBoBIBDmDBDxCBVUBCgBBZzBBNjCBCtBtBBEBECCBBBLgBBGiBBOcBEyBBCLBQRRBOBLEBC2BBKNBTWBEkCBCCCZCBDPBDDBMFBDFBDFBKGBCGBCqBBCNBH6DBWj9KBNWBFwBBloItLBDpDBnBGBNEBGLBCMBCEBCCCBCCBCCBqDBiBqLBT-BBD1BBpBLB1DEBCmEBlBZBHZBM4CBEFBDFBDFBDCBkBLBCZBCSBCBBCOBDNBjB6DBmC0BBsIcBEwBBwBfBOdBGqBBGdBDjBBFHBCEBrB9EBTjBBFjBBFnBBJzBBNKBCOBCGBCBBCKBCOBCGBCBBEzBBN2JBKVBLHBZFBCpBBCIBmCFBDCCBqBBCBBEDDBVBLWBKeBiCSBCBBLVBLZBHZBnB3BBHBBhCDBCBBGHBCCBCcBrBcBEcBkBHBCbBc1BBLVBLSBORBvDoCB4ByBBOyBBOnBBjBbBEGGBVB7HpBBCBBEBBRFBzBCBEcBLJJBUBrBRBvBUBcWBKlCBsBEBL4BBKOOBXBYyBBSDBJiBBEKKB+BBCDBKBBLCCkBRBChBBDHHBCB-BGBCCCBCBCOBCJBI4BBYDBCHBDBBDVBCGBCBBCEBEHBDBBDBBEHHGGBdJBCDDClBBCJBCDDCDBCBBECCtBhCBCCBCDBVCBfhCBDBBC5F5FB0BBDGBaFBjB+BBCEE8B1BBDoCoCBZBDNBWGB6F4BBoD-BBgBHBDDDBGBCBBCdBCBBDBBDDB+CHBDtBBDFBCCCBccBxBBDJBSnCBGTTBnCBoDHB5CgBBgBIBCsBBCGBCyByBBcBDVBCNBqCGBCBBCrBBECCBCCBBBCDDBZZBEBCBBCkBBCBBCDBCYYBqBBlIWBKQBCoBBECBwDwCwCB4cBnDuDBSjGBtyCgDBQvhBBSFBa68DBGmSB61GuBBy2B4RBIeBSuCBSdBTvBBRDBgBUBGSBxNsBB0G-BBhBYBDYBtBqCBF4BBIQBhCBBCNNBFBK1mHBqBfBiDyDB+vIDBCGBCBBCiJBQeeBBBDPPBCBJrMBloCqDBGMBEIBIJBFi7Fi7FBzCBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDYBCYBCeBCYBCeBCYBCeBCYBCeBCYBCHB15BeBHFB2GGBCQBDGBCBBCEBG9BBiBxDxDBrBBLGBRiKiKBcBTrBBlPbBlHdBDwGwGBdBCVBJBBhHGBCDBCBBCOBCkGB8BjCBEEE1lBDBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQB1TZBHZBHZB3zD-2pBBhB9oEBDt0FBDwpHBQtTBjtC9QBjvBq6EBGppIB", false)),
    Dash: () => new UnicodeRangeTable(decodeRanges("tB9qB9qB0BiyDiyDmgBqgCqgCBEB+BoBoBQnMnMlgDDDgBBBFdd-NUUwDxszBxszBBmBmBLqFqFhzD-J-J", false)),
    Emoji: () => new UnicodeRangeTable(decodeRanges("jBHHGJBwDFFu8HNN5GXX7CFBQBBwLBBNnFnFaKBFCBoGoHoHBLLK7B7BBCBCEBKGDBDDFDDCBBDIEBJJBBBGCCGLBMBBDCCBCCTDDBTTBEBCCCBEEBGGDBBFBBMBBGBBDGGBECBVVBGGBEBCDBDFFDDDBEBCDDCCCHEEHLLBQQDFFCFFBBBCMMBxBxBBBBKeP1LBBwOCBUBB0BFF7mBNN6SCCrrvDrGrGhFBBNBBPDDBIBsCZBCBBYVVDIBWBBvFhBBDvDBDBBCCBDyCBDCBCmIBC+BBMFBCXBIBBDHBNDDBCBDFFBOOBDDJBBKGGBBBNCBJCBDCCFHHEHHB0CBxBlCBGHBDDBEJBECCBEEDJBkHLBF8I8IBtBBCJBC4FBxDMBEKBE4BBCFFBOBDLBFJB", false)),
    Emoji_Component: () => new UnicodeRangeTable(decodeRanges("jBHHGJB0+H2G2Gsp3B3+8B3+8BBYB8PEBxtBDBtzhY-CB", false)),
    Emoji_Modifier: () => new UnicodeRangeTable(decodeRanges("7-8DE", true)),
    Emoji_Modifier_Base: () => new UnicodeRangeTable(decodeRanges("9wJ8G8GRDB4jzD9B9BBBBDDDBBB2DBBDKBWSBEFFBBBCCBICCZqGqGBFFWFFBvFvFBBBEEB0CRRBBBKMMgSDDJHBHKKBIBDCB5B+B+BBCCBCCSCBCMBmHCBrBIB", false)),
    Emoji_Presentation: () => new UnicodeRangeTable(decodeRanges("64IBBuGDBEDDqQBBWBBzBLBsBUUOJJBSSBGGBJJGWWIBBCFFDIIFBBdkBkBCFFBBBC+B+BBBBZPP8aBB0BFFvlxDrGrG-FDDBIBsCZBCZZVDDBDBCCBWBBvFgBBNIBClCBCVBNqBBFEBNQBEEEBlCBCCCB5FBD+BBODBCXBTbbBOO3C0CBxBlCBHEEBBBDDBEDBMBBIIBkHLBF8I8IBtBBCJBC4FBxDMBEKBE4BBCFFBOBDLBFJB", false)),
    Extended_Pictographic: () => new UnicodeRangeTable(decodeRanges("pFFFu8HNN5GXX7CFBQBBwLBBNnFnFaKBFCBoGoHoHBLLK7B7BBCBCEBKGDBDDFDDCBBDIEBJJBBBGCCGLBMBBDCCBCCTDDBTTBEBCCCBEEBGGDBBFBBMBBGBBDGGBECBVVBGGBEBCDBDFFDDDBEBCDDCCCHEEHLLBQQDFFCFFBBBCMMBxBxBBBBKeP1LBBwOCBUBB0BFF7mBNN6SCCrrvDoBoBBCBlDLBQBBQPPBmBmBBIBxDBBNBBPDDBIBU3BBcOBLVVDIBCDBKWBH7FBDvDBDBBCCBDyCBDCBCDBG9HBC+BBMFBCXBIBBDHBNDDBCBDFFBOOBDDJBBKGGBBBNCBJCBDCCFHHEHHB0CBxBlCBGHBDQBECCBEBDMB7GlBBNDB5BHBLFBpBHBfBBNDBDNBKmBBNuBBCJBC4FB5CHBPxEBhI9fB", false)),
    Hex_Digit: () => new UnicodeRangeTable(decodeRanges("wBJIFbFq1-BJIFbF", true)),
    Lowercase: () => new UnicodeRangeTable(decodeRanges("hDZBwBLLFlBlBBWBCHBC2BCBQCBuBCDECBBBDCCDEEBFFDEEBBBDDDCCCDCCBCCDEECDDBDDBBBHGDCOCBSCBDDCEEC4BCBFBDDDBCCFICBjCBDiBBIBBfEBhDsBsBCEEDDBTccBhBBCBBECBCWCBDBCGDB0B0BBuBBCgBCK0BCDMCBgDCxBoBBo6CqBBCDB5XFBjkCIBC2D2DB+FBiC0ECBHBCgDCBHBJFBLHBJHBJFBLHBJHBJNBDHBJHBJHBJEBCBBHEEBBBCBBJDBDBBJHBLCBCBB6DOORMBuDEEBEEcKFDBBJDBFiBiBBOBFsasaBYBn6BvBBCEEBGCFCCBCCBGBEiDCBIICFFNlBBCGG0oesBCUaCBBBmEMCBBBC8BCBIBCCCDICFCCDCCBBBCSCGGGCMCFCCDOCWDBCCCBBB2ZqBBCNBHvCBh6TGBNEBqhBZBumBnBBpEjBB8EKBCOBCGBCBBkODDBBBCpBBCIBmoByBB+DVB75CfBhsVfB8BYBnqZZBbGBCRBbZBbDBCCCBFBCKBbZBbZBbZBbZBbZBbZBbZBbZBbbBdYBCFBbYBCFBbYBCFBbYBCFBbYBCFBC15B15BBIBCTBHFBmI9BB1lChBB", false)),
    Math: () => new UnicodeRangeTable(decodeRanges("rBRRBBBgBeeCuBuBFmBmBgB5W5WBBBDbbBDDBBBwQCBuwGccBBBMEEOPPBCBWEBMEBiCMBFEEBFFBDBTFFDJBCDDBEBHEEBDDBCCBBBCFBENBClClCBWBCFBCBBFBBFfBCHHBPPBqIBJDBVBB7CffBZBCZZMGB+NBBNJBFFBFBBDBBEEBPCCDFBMHBGBB6BCCeDBKCBxK-BBhI-PBxBUBDFB9+zB4Z4ZBEBCjFjFRCBeCCeCCkEHHBCBitDBBhrwBwoBwoBBzCBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDjJBDxBBhwFDBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQB1BBB-uCIB", false)),
    Quotation_Mark: () => new UnicodeRangeTable(decodeRanges("iBFFkEQQ96HHBaBBowDqOqOBCBOCBixzBDB+FFF7CBB", false)),
    Terminal_Punctuation: () => new UnicodeRangeTable(decodeRanges("hBLLCMMBEE-ZJJiQ6B6BpCPPCCB1FsBsBBJBCsHsHB3B3BBEBCHBgBmImIB1nB1nBBtFtFFFB4JBB2YHBmY9D9DBBBoCBB+ECBEoBoBBCBDBB7JBBjLDBjFBBLBBCCBeCB8FEB-BBBldYYBKKBBBwlDCBzJOOFLLCBBEBBtNBB8ndBBuICBkHEB-LBB3CBBgD4E4EBBB0ECBgERRB6H6HnxUDDB6B6BBBBCDBqFLLCMMBEEiCDD7hBxBxBnkBoGoG3JBB5EFBlCFB6CDB5dEBtBDB+FGBxDDBgECBiEBBHRRB5C5CBDBtDrJrJB2D2DBBBNBBnLDBEOBqDBB6HCBmQCC8HBB4CBBFBB-MCBuBmUmUBrCrCBspBspBBDB6vRBBmEiCiCBBBLqRqRBoJoJBnwTnwTovHDB", false)),
    Uppercase: () => new UnicodeRangeTable(decodeRanges("hCZBmDWBCGBiB2BCDOCDuBCBECEBBCCCBCCBBBDDBCBBCCBEBBCBBCECBCCDCCBCCBBBCCCBEEIJDCMCDQCDDDCCBC4BCIBBCBBDCCBCBCGCiJCCEJJHCCBBBCCCBCCBPBCIBkBDDBBBEWCGDDCBBDyBBxBgBCK2BCBMCD+CCDlBBq6ClBBCGGzW1CB0kCHHBpBBDCBhK0ECKgDCKHBJFBLHBJHBJFBMGCJHBpCDBNDBNDBNEBMDBnIFFECBDCBDEEBDBHGCBCBDDBLBBGbbBOBUzZzZBYBx5BvBBxBCCBBBDGCBCBCDDJCBCgDCJCCFuqeuqeCqBCUaCoEMCE8BCLECBICFCCDCCEUCBDBCEBCOCBCBCCCBQCZs5Vs5VBYBmmBnBBpEjBB9EKBCOBCGBCBBr3ByBB+EVB75CfBhsVfBhCYBoqZZBbZBbZBbCCBGDBDDBCBCHBbZBbBBCDBDHBCGBcBBCDBCEBCEEBFBcZBbZBbZBbZBbZBbZBfYBiBYBiBYBiBYBiBYBiB2pE2pEBgBBvgCZBHZBHZB", false)),
    White_Space: () => new UnicodeRangeTable(decodeRanges("JEBTlDlDbgvFgvFgsCKBeBBGwBwBh9DAB", false))
  });
  static get Upper() {
    return this.CATEGORIES.get("Lu");
  }
  static SCRIPTS = new LazyMap({
    Adlam: () => new UnicodeRangeTable(decodeRanges("go6DrCFJFB", true)),
    Ahom: () => new UnicodeRangeTable(decodeRanges("g4lCaDOFW", true)),
    Anatolian_Hieroglyphs: () => new UnicodeRangeTable(decodeRanges("ggxCmS", true)),
    Arabic: () => new UnicodeRangeTable(decodeRanges("gwBEBCFBCNBCCBCfBCJBMZBCrDBChBBxCvBBxHhBBGqCBCcBxy8BtPBDvEBhBPBxDEBCmEBk7DeBkCFBJIBiBFBh43BDBCaBCBBCDDCJBCDBCCCHFFCECBBBCBBCDDCICBCCDDBCGBCDBCDBCCCBIBCQBGCBCEBCQB1BBB", false)),
    Armenian: () => new UnicodeRangeTable(decodeRanges("xpBlBDxBDCks9BE", true)),
    Avestan: () => new UnicodeRangeTable(decodeRanges("g4iC1BEG", true)),
    Balinese: () => new UnicodeRangeTable(decodeRanges("g4GsCCxB", true)),
    Bamum: () => new UnicodeRangeTable(decodeRanges("g1pB3CpowB4R", true)),
    Bassa_Vah: () => new UnicodeRangeTable(decodeRanges("w26CdDF", true)),
    Batak: () => new UnicodeRangeTable(decodeRanges("g+GzBJD", true)),
    Bengali: () => new UnicodeRangeTable(decodeRanges("gsCDBCHBDBBDVBCGBCEEBCBDIBDBBDDBJFFBCCBDBDYB", false)),
    Beria_Erfe: () => new UnicodeRangeTable(decodeRanges("g17CYDY", true)),
    Bhaiksuki: () => new UnicodeRangeTable(decodeRanges("ggnCICsBCNLc", true)),
    Bopomofo: () => new UnicodeRangeTable(decodeRanges("qXB6wLqBxDf", true)),
    Brahmi: () => new UnicodeRangeTable(decodeRanges("ggkCtCFjBKA", true)),
    Braille: () => new UnicodeRangeTable(decodeRanges("ggK-H", true)),
    Buginese: () => new UnicodeRangeTable(decodeRanges("gwGbDB", true)),
    Buhid: () => new UnicodeRangeTable(decodeRanges("g6FT", true)),
    Canadian_Aboriginal: () => new UnicodeRangeTable(decodeRanges("ggF-TxRlC7tgCP", true)),
    Carian: () => new UnicodeRangeTable(decodeRanges("g1gCwB", true)),
    Caucasian_Albanian: () => new UnicodeRangeTable(decodeRanges("wphCzBMA", true)),
    Chakma: () => new UnicodeRangeTable(decodeRanges("gokC0BCR", true)),
    Cham: () => new UnicodeRangeTable(decodeRanges("gwqB2BKNDJDD", true)),
    Cherokee: () => new UnicodeRangeTable(decodeRanges("g9E1CDFz7lBvC", true)),
    Chorasmian: () => new UnicodeRangeTable(decodeRanges("w9jCb", true)),
    Common: () => new UnicodeRangeTable(decodeRanges("AgCBbFBbuBBCOBCEBYgBgBiOmBBGEBDTB1DKKHCC+THHPEEhB9E9ElQiEiEB6mB6mB2MDBjJwvBwvBBBBoCBBsGBBCumBumBOIIBCBCFBCCBDmYmYBKBD2CBCKBEKBCOBShBB-BlBBCCBDFBCaBCQBqBCBF5UBXKBW-cBhIzTBDpEBhQ9CBzMUBCCCBXBQHBFDB8CBBE7C7CB0E0EBOBhBlBBKxBxBB+BBgBwCBwB5C5CBmFBhuG-BBhoWhBBnDCBmFJB1HhFhFsMPPBzuUzuUBxGxGBIBXiBBCSBCDB0ECCBeBbFBbKBLuBuBBhChCBFBCGBLEBjICBFsBBEIBxCMB0BsBBlHaBltuBDB96D8HBEzNBHWBQQBgDzDB9B1HBLmBBD9BBEQBJBBIdBF8BB2GTBNTBN2CBKYBoE0CBCmCBCBBDDDBDDBCBCLBCCCBFBCgCBCDBDHBCGBCbBCDBCEBCEEBFBCzKBDjJBDxBByjFjCBtC8BBjWrBBFjDBNOBDOBCOBCkBBLtFB5BZBCBBOrBBFIBIBBPFB7E4eBEQBEMBE5GBHLBFQQBKBF3BBJJBHnBBJdBDLBFBBPIBoB3KBJNBDMBEKBE4BBCFFBOBDLBFJBIyEBCmDBnghYffB+CB", false)),
    Coptic: () => new UnicodeRangeTable(decodeRanges("ifNxkKzDGG", true)),
    Cuneiform: () => new UnicodeRangeTable(decodeRanges("ggoC5cnDuDCEMjG", true)),
    Cypriot: () => new UnicodeRangeTable(decodeRanges("ggiCFBDCCBqBBCBBEDD", false)),
    Cypro_Minoan: () => new UnicodeRangeTable(decodeRanges("w8rCiD", true)),
    Cyrillic: () => new UnicodeRangeTable(decodeRanges("ggBkEBDoFBx6FKBhFtCtCojEfBhie-CBv8VBBhw4B9BBiBAB", false)),
    Deseret: () => new UnicodeRangeTable(decodeRanges("gghCvC", true)),
    Devanagari: () => new UnicodeRangeTable(decodeRanges("goCwCFODZh7nBfhwcJ", true)),
    Dives_Akuru: () => new UnicodeRangeTable(decodeRanges("gomCGBDDDBGBCBBCdBCBBDLBKJB", false)),
    Dogra: () => new UnicodeRangeTable(decodeRanges("ggmC7B", true)),
    Duployan: () => new UnicodeRangeTable(decodeRanges("ggvDqDGMEIIJDD", true)),
    Egyptian_Hieroglyphs: () => new UnicodeRangeTable(decodeRanges("ggsC1iBL68D", true)),
    Elbasan: () => new UnicodeRangeTable(decodeRanges("gohCnB", true)),
    Elymaic: () => new UnicodeRangeTable(decodeRanges("g-jCW", true)),
    Ethiopic: () => new UnicodeRangeTable(decodeRanges("gwEoCBCDBDGBCCCBCBDoBBCDBDgBBCDBDGBCCCBCBDOBC4BBCDBDiCBDfBEZBnvGWBKGBCGBCGBCGBCGBCGBCGBCGBjpfFBDFBDFBKGBCGBylvCGBCDBCBBCOB", false)),
    Garay: () => new UnicodeRangeTable(decodeRanges("gqjClBEcJB", true)),
    Georgian: () => new UnicodeRangeTable(decodeRanges("glElBBCGGDqBBCDBx8CqBBDCBhiElBBCGG", false)),
    Glagolitic: () => new UnicodeRangeTable(decodeRanges("ggL-Ch9sDGCQDGCBCE", true)),
    Gothic: () => new UnicodeRangeTable(decodeRanges("w5gCa", true)),
    Grantha: () => new UnicodeRangeTable(decodeRanges("g4kCDBCHBDBBDVBCGBCBBCEBDIBDBBDCBDHHGGBDGBEEB", false)),
    Greek: () => new UnicodeRangeTable(decodeRanges("wbDBCCBDDBCFFCCCBBBCCCBSBC+BBPPBnpGEBzBEBFEB1ChKhKBUBDFBDlBBDFBDHBCGCBdBD0BBCOBCNBDFBCSBDCBCIBoJ-xiB-xiB7uVuCBSgj0Bgj0BBkCB", false)),
    Gujarati: () => new UnicodeRangeTable(decodeRanges("h0CCBCIBCCBCVBCGBCBBCEBDJBCCBCCBDQQBCBDLBIGB", false)),
    Gunjala_Gondi: () => new UnicodeRangeTable(decodeRanges("grnCFCBCkBCBCFIJ", true)),
    Gurmukhi: () => new UnicodeRangeTable(decodeRanges("hwCCBCFBFBBDVBCGBCBBCBBCBBDCCBDBFBBDCBEIIBCBCIIBPB", false)),
    Gurung_Khema: () => new UnicodeRangeTable(decodeRanges("go4C5B", true)),
    Han: () => new UnicodeRangeTable(decodeRanges("g0LZBC4CBN1GBwBCCaIBPDBle-tGBhC-vUBhoWtLBDpDBpodBBNGBqgkB-2pBBhB9oEBDt0FBDwpHBQtTBjtC9QBjvBq6EBGppIB", false)),
    Hangul: () => new UnicodeRangeTable(decodeRanges("goE-HvxHBiI9CyDeiCei3dckUj9KNWFwBl9JeEFDFDFDC", true)),
    Hanifi_Rohingya: () => new UnicodeRangeTable(decodeRanges("gojCnBJJ", true)),
    Hanunoo: () => new UnicodeRangeTable(decodeRanges("g5FU", true)),
    Hatran: () => new UnicodeRangeTable(decodeRanges("gniCSCBGE", true)),
    Hebrew: () => new UnicodeRangeTable(decodeRanges("xsB2BBJaBFFBpp9BZBCEBCCCBCCBCCBIB", false)),
    Hiragana: () => new UnicodeRangeTable(decodeRanges("hiM1CBHCBi7-C+IBTeeBBBulQAB", false)),
    Imperial_Aramaic: () => new UnicodeRangeTable(decodeRanges("giiCVCI", true)),
    Inherited: () => new UnicodeRangeTable(decodeRanges("gYvDB2IBBlOKBbhXhXBCB8qEtBBDLBlPCBCMBCGBFHHEBBnG-BBtQBBjGgBB65DDBsDBBmrzBPBRNBwejHjH7iEl+uBl+uBBsBBDWBhRCBSHBDGBfDBz6rYvHB", false)),
    Inscriptional_Pahlavi: () => new UnicodeRangeTable(decodeRanges("g7iCSGH", true)),
    Inscriptional_Parthian: () => new UnicodeRangeTable(decodeRanges("g6iCVDH", true)),
    Javanese: () => new UnicodeRangeTable(decodeRanges("gsqBtCDJFB", true)),
    Kaithi: () => new UnicodeRangeTable(decodeRanges("gkkCiCLA", true)),
    Kannada: () => new UnicodeRangeTable(decodeRanges("gkDMCCCWCJCEDICCCDIBGCCDDJCC", true)),
    Katakana: () => new UnicodeRangeTable(decodeRanges("hlM5CBDCBxHPBxGuBBC3CBvgzBJBCsBBzisBDBCGBCBBCgJgJBBBzBPPBCB", false)),
    Kawi: () => new UnicodeRangeTable(decodeRanges("g4nCQCoBEc", true)),
    Kayah_Li: () => new UnicodeRangeTable(decodeRanges("goqBtBCA", true)),
    Kharoshthi: () => new UnicodeRangeTable(decodeRanges("gwiCDCBGHCCCcDCFJII", true)),
    Khitan_Small_Script: () => new UnicodeRangeTable(decodeRanges("k-7C84G84GB0OBqBAB", false)),
    Khmer: () => new UnicodeRangeTable(decodeRanges("g8F9CDJHJnPf", true)),
    Khojki: () => new UnicodeRangeTable(decodeRanges("gwkCRCuB", true)),
    Khudawadi: () => new UnicodeRangeTable(decodeRanges("w1kC6BGJ", true)),
    Kirat_Rai: () => new UnicodeRangeTable(decodeRanges("gq7C5B", true)),
    Lao: () => new UnicodeRangeTable(decodeRanges("h0DBBCCCBDBCXBCCCBVBDEBCCCBFBCJBDDB", false)),
    Latin: () => new UnicodeRangeTable(decodeRanges("hCZBHZBwBQQGWBCeBCgOBoBEB8wGlBBHwBBGDBGMBClCBiC-HByLOORMBuEBBHccSoBB42CfBj1elDBExCBVOBxZqBBCIBCDB38TGB7gBZBHZBmhCFBCpBBCIBm61BeBHFB", false)),
    Lepcha: () => new UnicodeRangeTable(decodeRanges("ggH3BEOEC", true)),
    Limbu: () => new UnicodeRangeTable(decodeRanges("goGeBCLBFLBFEEBKB", false)),
    Linear_A: () => new UnicodeRangeTable(decodeRanges("gwhC2JKVLH", true)),
    Linear_B: () => new UnicodeRangeTable(decodeRanges("gggCLCZCSCBCODNjB6D", true)),
    Lisu: () => new UnicodeRangeTable(decodeRanges("wmpBvBx1eA", true)),
    Lycian: () => new UnicodeRangeTable(decodeRanges("g0gCc", true)),
    Lydian: () => new UnicodeRangeTable(decodeRanges("gpiCZGA", true)),
    Mahajani: () => new UnicodeRangeTable(decodeRanges("wqkCmB", true)),
    Makasar: () => new UnicodeRangeTable(decodeRanges("g3nCY", true)),
    Malayalam: () => new UnicodeRangeTable(decodeRanges("goDMCCCyBCCCFFPDZ", true)),
    Mandaic: () => new UnicodeRangeTable(decodeRanges("giCbDA", true)),
    Manichaean: () => new UnicodeRangeTable(decodeRanges("g2iCmBFL", true)),
    Marchen: () => new UnicodeRangeTable(decodeRanges("wjnCfDVCN", true)),
    Masaram_Gondi: () => new UnicodeRangeTable(decodeRanges("gonCGBCBBCrBBECCBCCBHBJJB", false)),
    Medefaidrin: () => new UnicodeRangeTable(decodeRanges("gy7C6C", true)),
    Meetei_Mayek: () => new UnicodeRangeTable(decodeRanges("g3qBWqGtBDJ", true)),
    Mende_Kikakui: () => new UnicodeRangeTable(decodeRanges("gg6DkGDP", true)),
    Meroitic_Cursive: () => new UnicodeRangeTable(decodeRanges("gtiCXFTDtB", true)),
    Meroitic_Hieroglyphs: () => new UnicodeRangeTable(decodeRanges("gsiCf", true)),
    Miao: () => new UnicodeRangeTable(decodeRanges("g47CqCF4BIQ", true)),
    Modi: () => new UnicodeRangeTable(decodeRanges("gwlCkCMJ", true)),
    Mongolian: () => new UnicodeRangeTable(decodeRanges("ggGBBDCCBSBH4CBIqBB2t-BMB", false)),
    Mro: () => new UnicodeRangeTable(decodeRanges("gy6CeCJFB", true)),
    Multani: () => new UnicodeRangeTable(decodeRanges("g0kCGBCCCBCBCOBCKB", false)),
    Myanmar: () => new UnicodeRangeTable(decodeRanges("ggE-EhqmBeiDfxibT", true)),
    Nabataean: () => new UnicodeRangeTable(decodeRanges("gkiCeJI", true)),
    Nag_Mundari: () => new UnicodeRangeTable(decodeRanges("wm5DpB", true)),
    Nandinagari: () => new UnicodeRangeTable(decodeRanges("gtmCHDtBDK", true)),
    New_Tai_Lue: () => new UnicodeRangeTable(decodeRanges("gsGrBFZHKEB", true)),
    Newa: () => new UnicodeRangeTable(decodeRanges("gglC7CCE", true)),
    Nko: () => new UnicodeRangeTable(decodeRanges("g+B6BDC", true)),
    Nushu: () => new UnicodeRangeTable(decodeRanges("h-7CvsQvsQBqMB", false)),
    Nyiakeng_Puachue_Hmong: () => new UnicodeRangeTable(decodeRanges("go4DsBENDJFB", true)),
    Ogham: () => new UnicodeRangeTable(decodeRanges("g0Fc", true)),
    Ol_Chiki: () => new UnicodeRangeTable(decodeRanges("wiHvB", true)),
    Ol_Onal: () => new UnicodeRangeTable(decodeRanges("wu5DqBFA", true)),
    Old_Hungarian: () => new UnicodeRangeTable(decodeRanges("gkjCyBOyBIF", true)),
    Old_Italic: () => new UnicodeRangeTable(decodeRanges("g4gCjBKC", true)),
    Old_North_Arabian: () => new UnicodeRangeTable(decodeRanges("g0iCf", true)),
    Old_Permic: () => new UnicodeRangeTable(decodeRanges("w6gCqB", true)),
    Old_Persian: () => new UnicodeRangeTable(decodeRanges("g9gCjBFN", true)),
    Old_Sogdian: () => new UnicodeRangeTable(decodeRanges("g4jCnB", true)),
    Old_South_Arabian: () => new UnicodeRangeTable(decodeRanges("gziCf", true)),
    Old_Turkic: () => new UnicodeRangeTable(decodeRanges("ggjCoC", true)),
    Old_Uyghur: () => new UnicodeRangeTable(decodeRanges("w7jCZ", true)),
    Oriya: () => new UnicodeRangeTable(decodeRanges("h4CCCHDBDVCGCBCEDIDBDCICFBCEDR", true)),
    Osage: () => new UnicodeRangeTable(decodeRanges("wlhCjBFjB", true)),
    Osmanya: () => new UnicodeRangeTable(decodeRanges("gkhCdDJ", true)),
    Pahawh_Hmong: () => new UnicodeRangeTable(decodeRanges("g46ClCLJCGCUGS", true)),
    Palmyrene: () => new UnicodeRangeTable(decodeRanges("gjiCf", true)),
    Pau_Cin_Hau: () => new UnicodeRangeTable(decodeRanges("g2mC4B", true)),
    Phags_Pa: () => new UnicodeRangeTable(decodeRanges("giqB3B", true)),
    Phoenician: () => new UnicodeRangeTable(decodeRanges("goiCbEA", true)),
    Psalter_Pahlavi: () => new UnicodeRangeTable(decodeRanges("g8iCRIDNG", true)),
    Rejang: () => new UnicodeRangeTable(decodeRanges("wpqBjBMA", true)),
    Runic: () => new UnicodeRangeTable(decodeRanges("g1FqCEK", true)),
    Samaritan: () => new UnicodeRangeTable(decodeRanges("ggCtBDO", true)),
    Saurashtra: () => new UnicodeRangeTable(decodeRanges("gkqBlCJL", true)),
    Sharada: () => new UnicodeRangeTable(decodeRanges("gskC-ChsCH", true)),
    Shavian: () => new UnicodeRangeTable(decodeRanges("wihCvB", true)),
    Siddham: () => new UnicodeRangeTable(decodeRanges("gslC1BDlB", true)),
    Sidetic: () => new UnicodeRangeTable(decodeRanges("gqiCZ", true)),
    SignWriting: () => new UnicodeRangeTable(decodeRanges("gg2DrUQECO", true)),
    Sinhala: () => new UnicodeRangeTable(decodeRanges("hsDCBCRBEXBCIBCDDBFBEFFBEBCCCBGBHJBDCBt-gCTB", false)),
    Sogdian: () => new UnicodeRangeTable(decodeRanges("w5jCpB", true)),
    Sora_Sompeng: () => new UnicodeRangeTable(decodeRanges("wmkCYIJ", true)),
    Soyombo: () => new UnicodeRangeTable(decodeRanges("wymCyC", true)),
    Sundanese: () => new UnicodeRangeTable(decodeRanges("g8G-BhIH", true)),
    Sunuwar: () => new UnicodeRangeTable(decodeRanges("g+mChBPJ", true)),
    Syloti_Nagri: () => new UnicodeRangeTable(decodeRanges("ggqBsB", true)),
    Syriac: () => new UnicodeRangeTable(decodeRanges("g4BNC7BDCxIK", true)),
    Tagalog: () => new UnicodeRangeTable(decodeRanges("g4FVKA", true)),
    Tagbanwa: () => new UnicodeRangeTable(decodeRanges("g7FMCCCB", true)),
    Tai_Le: () => new UnicodeRangeTable(decodeRanges("wqGdDE", true)),
    Tai_Tham: () => new UnicodeRangeTable(decodeRanges("gxG+BCcDKHJHN", true)),
    Tai_Viet: () => new UnicodeRangeTable(decodeRanges("g0qBiCZE", true)),
    Tai_Yo: () => new UnicodeRangeTable(decodeRanges("g25DeCVJB", true)),
    Takri: () => new UnicodeRangeTable(decodeRanges("g0lC5BHJ", true)),
    Tamil: () => new UnicodeRangeTable(decodeRanges("i8CBBCFBECBCDBEBBCCCBEEBEEBBBELBFEBECBCDBDHHPUBm+kCxBBOAB", false)),
    Tangsa: () => new UnicodeRangeTable(decodeRanges("wz6CuCCJ", true)),
    Tangut: () => new UnicodeRangeTable(decodeRanges("g-7CgBgBB+3GBhQeBiDyDB", false)),
    Telugu: () => new UnicodeRangeTable(decodeRanges("ggDMCCCWCPDICCCDIBCCCBDDDJII", true)),
    Thaana: () => new UnicodeRangeTable(decodeRanges("g8BxB", true)),
    Thai: () => new UnicodeRangeTable(decodeRanges("hwD5BGb", true)),
    Tibetan: () => new UnicodeRangeTable(decodeRanges("g4DnCCjBFmBCjBCOCGFB", true)),
    Tifinagh: () => new UnicodeRangeTable(decodeRanges("wpL3BIBPA", true)),
    Tirhuta: () => new UnicodeRangeTable(decodeRanges("gklCnCJJ", true)),
    Todhri: () => new UnicodeRangeTable(decodeRanges("guhCzB", true)),
    Tolong_Siki: () => new UnicodeRangeTable(decodeRanges("wtnCrBFJ", true)),
    Toto: () => new UnicodeRangeTable(decodeRanges("w04De", true)),
    Tulu_Tigalari: () => new UnicodeRangeTable(decodeRanges("g8kCJBCDDClBBCJBCDDCDBCJBCBBJBB", false)),
    Ugaritic: () => new UnicodeRangeTable(decodeRanges("g8gCdCA", true)),
    Unknown: () => new UnicodeRangeTable(decodeRanges("4bBBHDBICCVuMuMnBBBzBBBE4B4BBGBcDBHKBvI9B9BBmDmDBMB8BBByBBBQddBCCMEBjBEBuHJJBDDBXXICCBBBFBBKBBDBBFHBCDBDGGBaaBEEHDBDBBXIIDGDBCCGDBDBBECBCGBFCCBFBSJBEKKEXXIDDGBBLIEBCCBNBFBBNGBIEEJBBDBBXIIDGGBKKBDDBEEBFBEDBDGGBTTBIBDHHBBBEFFBBBDCCDCBDCBECBNDBGCBEFFBCCBEBCNBWEBOEEYRRBKKEFFBFBDEEDBBFBBLGBXEEYLLGBBKEEFGBDEBEFFBLLELBOEE0BEEHDBRBBbEETCBZKKCBBICBCDBHCCJFBLBBELB7BDBekBBDCCGZZCYYBGGCIILBBFfBpClBlBBCBoBlBlBQOOBjBBnGCCBDBCBB6LFFBIICFFBqBqBFBBiBFFBIICFFBQQ6BFFBkCkCBhBhBBBBbFB3CBBHBB+UCB6CGBXIBZIBVLBOEEDLB-CBBLFBLFBbFB6CGBsBEBnCJBgBNNBCBNDBCCBrBBBGKBtBDBbFBMCB-BBBiCeeBMMBEBLFBPBBvBBBNTBuCnFnFBGB9BCBQCB-BEBsBBBMHBsBEB3QBBHBBnBBBHBBJGCgBBB2BQQPBBHUUBEEKmDmDNBBcOOBBBjBNBiBOBtEDB7UVBMUB14BBB-LEBuBCCBDBCBB5BGBDNBZIBI4BI-DhBBb6C6CBKB3GZBxC3C3CBoDoDBDBsB-C-C3CIBxBuzcuzcBBB4BIB9KTB5FHB+GTB9BCBLFB5BHBnCHBNFB1DKBfCBvCMMBCBiB4B4BBHBPBBLBBoDXBdJBHBBHBBHIBIII9BDB-DBBLFBl9KLBYDByBjoIBvLBBrDlBBILBGEBbGGCGDrUfBrBFB0BUUFDBGoEoEBCC-FCBHBBHBBHBBECBIIIBIBGBBNbbUDDQBBPhBB8DEBEDBuBCB5COOBBBCuBBvBhEBeCByBOBdDBlBIBfEBsBEBfmBmBBCBPpBB-EBBLFBlBDBlBDBpBHB1BKBNQQIDDMQQIDDBBB1BLB4JIBXJBJXBHrBrBKkCBHBBCtBtBDCBCBBYpCpCBGBKvBBUDDBDBiBCBcEBclBB5BDBVBBzBDDBDBJEEeBBEDBLGBKGBhCfBoBDBNIB3BCBeBBcEBbGBFLBIvCBqC2BB0BMB0BGBvBHBLFBnBCBeHBDvGBgBrBrBEBBDPBHHBKgBBvBHBrBVBblBBdTBYIBvCDBlBIBlCJBCBBaGBLFB2BTTBGBoBIBhDVVBJBTwBwBB8BBICCFQQMFB8BEBLFBFJJBDDBXXIDDGLLBDDBEEBCCBEBCEBIBBICBGKBLCCBCCnBLLCBBCFFLDDBGBDcB9CGGBcBpCHBLlFB3BBBnBhBBmCKBLFBOSB7BFBLFBVbBcBBQDBY4FB9BjDB0CLBJBBCBBJDDfDDBNNBHBLlCBJBBvBBBMaBpCHB0CMBqCGBL1CBJ3CBjBNBLFBKuBuBPJBeCBhBBBXPPBnCBIDDtBCBCDDKHBLFBHDDmBDDHGBLFBtBDBL1HBaGBSqBqBBBBe0CBCOBzBMB8clDBwDGGBJBlGryCBkDMB3iBJB88DEBoS41GB7Bl2BB6RGBgBLLBCByCLLBEBfBBHJBnCJBLIIWEBUvNB7BlGB8CEBaBBarBBsCDB6BGBS-BBGKBIIB3mHoBBhBgDB0D8vIBFIIDkJkJBNBCcBEBBCNBFHBtMjoCBsDEBOCBKGBLBBJ76DB+HCB1NFBYOBSOBvBBBYIB1D7BB3HJBoBBBjGUBnC5DBVLBVLB4CIBamEB2CoCoCDBBCBBDBBFNNCIIiCFFBJJIddFGGCCBI1K1KBlJlJB-V-VBNBGQQBuiBBgBFBH0GBISSBIIDGGBDB-BgBBCvDBuBCBPBBLDBD-JBgBQB7BEBCvOBrB1GBsBDBC-FBgBXXBGBD-GBIFFDQQmGBBRoBBtCDBLDBDwYBlCrCB+BhGBFccDCCBCCLFFCCCBEBCDBCECEDDCBBCICDCCBFFIKFCLLSEBEGGSzBBDtIBtBDBlDLBQBBQQQmBJBvF3BBeMBtBDBKGBDNBH5EB6eCBSCBOCB7GFBNDBCOBNDB5BHBLFBpBHBfBBNDBDNBKmBB5KHBPBBOCBMCB6BCCBCBRBBNDBLGB0EoDoDBjgBBh3pBfB-oEBBv0FBBypHOBvThtCB-QhvBBs6EEBrpIm8yVBCdBhD-DBxHvw-FB", false)),
    Vai: () => new UnicodeRangeTable(decodeRanges("gopBrJ", true)),
    Vithkuqi: () => new UnicodeRangeTable(decodeRanges("wrhCKCOCGCBCKCOCGCB", true)),
    Wancho: () => new UnicodeRangeTable(decodeRanges("g24D5BGA", true)),
    Warang_Citi: () => new UnicodeRangeTable(decodeRanges("glmCyCNA", true)),
    Yezidi: () => new UnicodeRangeTable(decodeRanges("g0jCpBCCDB", true)),
    Yi: () => new UnicodeRangeTable(decodeRanges("ggoBskBE2B", true)),
    Zanabazar_Square: () => new UnicodeRangeTable(decodeRanges("gwmCnC", true))
  });
  static FOLD_CATEGORIES = new LazyMap({
    L: () => new UnicodeRangeTable(decodeRanges("laA", true)),
    LC: () => new UnicodeRangeTable(decodeRanges("laA", true)),
    Ll: () => new UnicodeRangeTable(decodeRanges("hCZBmDWBCGBiBuBCEECDOCDuBCBECEBBCCCBCCBBBDDBCBBCCBEBBCBBCECBCCDCCBCCBBBCCCBEEIBBCBBCBBCOCDQCDBBCCCBBBC4BCIBBCBBDCCBCBCGC3HrBrBCEEJHHCCBCCCBCCBPBCIBkBJJCUCGDDCBBDyBBxBgBCK2BCBMCD+CCDlBBq6ClBBCGGzW1CB0kCHHBpBBDCBhK0ECKgDCKHBJFBLHBJHBJFBMGCJHBZHBJHBJHBJEBMEBMDBNEBMEBqJEEBHHxC9zC9zCBuBBxBCCBBBDGCBCBCDDJCBCgDCJCCFuqeuqeCqBCUaCoEMCE8BCLECBICFCCDCCEUCBDBCEBCOCBCBCCCBQCZs5Vs5VBYBmmBnBBpEjBB9EKBCOBCGBCBBr3ByBB+EVB75CfBhsVfBhCYBoyehBB", false)),
    Lt: () => new UnicodeRangeTable(decodeRanges("kOCCBCCBCClBCCtsHHBJHBJHBMQQwBAB", false)),
    Lu: () => new UnicodeRangeTable(decodeRanges("hDZB7BqBqBBWBCHBCuBCEECDOCDsBCDECBBBDCCDEEGDDECBDDDCCCDFFDEECDDECCGBBCBBCBBCOCBSCDBBCEECkBCEQCJDDBCCFICBEBCBBCCCBEEBCCBCBCEBDCCBDDIDDCBBEFBGLLBnFnFsBCCEEEBBBvBDBCdBCBBECBCWCBDBCGD1BvBBCgBCK0BCDMCBgDCyBlBBq6CqBBDCB5XFBjkCIBCvHvHERRzD0ECGGGC8CCBHBJFBLHBJHBJFBMGCJHBJNBzBBBNSSBPPBEEpL2B2Bs1CvBBCEEBGCHDDLiDCJCCFNNBkBBCGG0oesBCUaCoEMCE8BCLCCDICFFFCBBDSCMOCFCCDOCb9a9advCBi8UZBumBnBBpEjBB8EKBCOBCGBCBBk4ByBB+DVB75CfBhsVfB8BYBvyehBB", false)),
    M: () => new UnicodeRangeTable(decodeRanges("5cgBgBlgHAB", false)),
    Mn: () => new UnicodeRangeTable(decodeRanges("5cgBgBlgHAB", false)),
    Emoji: () => new UnicodeRangeTable(decodeRanges("8mJA", true)),
    Extended_Pictographic: () => new UnicodeRangeTable(decodeRanges("8mJA", true)),
    Lowercase: () => new UnicodeRangeTable(decodeRanges("hCZBmDWBCGBiBuBCEECDOCDuBCBECEBBCCCBCCBBBDDBCBBCCBEBBCBBCECBCCDCCBCCBBBCCCBEEIBBCBBCBBCOCDQCDBBCCCBBBC4BCIBBCBBDCCBCBCGCiJCCEJJHCCBBBCCCBCCBPBCIBkBJJCUCGDDCBBDyBBxBgBCK2BCBMCD+CCDlBBq6ClBBCGGzW1CB0kCHHBpBBDCBhK0ECKgDCKHBJFBLHBJHBJFBMGCJHBZHBJHBJHBJEBMEBMDBNEBMEBqJEEBHHuBPBUzZzZBYBx5BvBBxBCCBBBDGCBCBCDDJCBCgDCJCCFuqeuqeCqBCUaCoEMCE8BCLECBICFCCDCCEUCBDBCEBCOCBCBCCCBQCZs5Vs5VBYBmmBnBBpEjBB9EKBCOBCGBCBBr3ByBB+EVB75CfBhsVfBhCYBoyehBB", false)),
    Math: () => new UnicodeRangeTable(decodeRanges("ycGDCHHFMMDDDCHHFAB", false)),
    Uppercase: () => new UnicodeRangeTable(decodeRanges("hDZB7BqBqBBWBCHBCuBCEECDOCDsBCDECBBBDCCDEEGDDECBDDDCCCDFFDEECDDECCGBBCBBCBBCOCBSCDBBCEECkBCEQCJDDBCCFICBEBCBBCCCBEEBCCBCBCEBDCCBDDIDDCBBEFBGLLBnFnFsBCCEEEBBBvBDBCdBCBBECBCWCBDBCGD1BvBBCgBCK0BCDMCBgDCyBlBBq6CqBBDCB5XFBjkCIBCvHvHERRzD0ECGGGC8CCBHBJFBLHBJHBJFBMGCJHBJNBzBBBNSSBPPBEEpLiBiBBOBFsasaBYBn6BvBBCEEBGCHDDLiDCJCCFNNBkBBCGG0oesBCUaCoEMCE8BCLCCDICFFFCBBDSCMOCFCCDOCb9a9advCBi8UZBumBnBBpEjBB8EKBCOBCGBCBBk4ByBB+DVB75CfBhsVfB8BYBvyehBB", false))
  });
  static FOLD_SCRIPT = new LazyMap({
    Common: () => new UnicodeRangeTable(decodeRanges("8cgBgB", false)),
    Greek: () => new UnicodeRangeTable(decodeRanges("1FwUwU", false)),
    Inherited: () => new UnicodeRangeTable(decodeRanges("5cgBgBlgHAB", false))
  });
};
var Unicode = class Unicode2 {
  static MAX_RUNE = 1114111;
  static MAX_ASCII = 127;
  static MAX_LATIN1 = 255;
  static MAX_BMP = 65535;
  static MIN_FOLD = 65;
  static MAX_FOLD = 125251;
  static MIN_HIGH_SURROGATE = 55296;
  static MAX_HIGH_SURROGATE = 56319;
  static MIN_LOW_SURROGATE = 56320;
  static MAX_LOW_SURROGATE = 57343;
  static MIN_SUPPLEMENTARY_CODE_POINT = 65536;
  static is32(ranges, r) {
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const m = lo + Math.floor((hi - lo) / 2);
      const rlo = ranges.getLo(m);
      const rhi = ranges.getHi(m);
      if (rlo <= r && r <= rhi) {
        const stride = ranges.getStride(m);
        return (r - rlo) % stride === 0;
      }
      if (r < rlo) hi = m;
      else lo = m + 1;
    }
    return false;
  }
  static is(ranges, r) {
    if (r <= Unicode2.MAX_LATIN1) {
      for (let i = 0; i < ranges.length; i++) {
        if (r > ranges.getHi(i)) continue;
        const rlo = ranges.getLo(i);
        if (r < rlo) return false;
        const stride = ranges.getStride(i);
        return (r - rlo) % stride === 0;
      }
      return false;
    }
    return ranges.length > 0 && r >= ranges.getLo(0) && Unicode2.is32(ranges, r);
  }
  static isUpper(r) {
    if (r <= Unicode2.MAX_LATIN1) {
      const s = String.fromCodePoint(r);
      return s.toUpperCase() === s && s.toLowerCase() !== s;
    }
    return Unicode2.is(UnicodeTables.Upper, r);
  }
  static isPrint(r) {
    if (r <= Unicode2.MAX_LATIN1) return r >= 32 && r < Unicode2.MAX_ASCII || r >= 161 && r !== 173;
    return Unicode2.is(UnicodeTables.Print, r);
  }
  static simpleFold(r) {
    if (UnicodeTables.CASE_ORBIT.has(r)) return UnicodeTables.CASE_ORBIT.get(r);
    const l = Codepoint.toLowerCase(r);
    if (l !== r) return l;
    return Codepoint.toUpperCase(r);
  }
  static equalsIgnoreCase(r1, r2) {
    if (r1 === r2) return true;
    if (r1 < 0 || r2 < 0) return false;
    if (r1 <= Unicode2.MAX_ASCII && r2 <= Unicode2.MAX_ASCII) {
      if (65 <= r1 && r1 <= 90) r1 |= 32;
      if (65 <= r2 && r2 <= 90) r2 |= 32;
      return r1 === r2;
    }
    for (let r = Unicode2.simpleFold(r1); r !== r1; r = Unicode2.simpleFold(r)) if (r === r2) return true;
    return false;
  }
};
var FAST_PATH_TABLE_SIZE = 256;
var WORD_RUNE_TABLE = new Uint8Array(FAST_PATH_TABLE_SIZE);
for (let i = 0; i < FAST_PATH_TABLE_SIZE; i++) WORD_RUNE_TABLE[i] = 97 <= i && i <= 122 || 65 <= i && i <= 90 || 48 <= i && i <= 57 || i === 95 ? 1 : 0;
var cachedNativeEncoder = null;
var cachedNativeDecoder = null;
var Utils = class Utils2 {
  static METACHARACTERS = "\\.+*?()|[]{}^$";
  static EMPTY_BEGIN_LINE = 1;
  static EMPTY_END_LINE = 2;
  static EMPTY_BEGIN_TEXT = 4;
  static EMPTY_END_TEXT = 8;
  static EMPTY_WORD_BOUNDARY = 16;
  static EMPTY_NO_WORD_BOUNDARY = 32;
  static EMPTY_ALL = -1;
  static emptyInts() {
    return [];
  }
  static isByteArray(input) {
    return Array.isArray(input) || input instanceof Uint8Array;
  }
  static isalnum(c) {
    return Codepoint.CODES.get("0") <= c && c <= Codepoint.CODES.get("9") || Codepoint.CODES.get("a") <= c && c <= Codepoint.CODES.get("z") || Codepoint.CODES.get("A") <= c && c <= Codepoint.CODES.get("Z");
  }
  static unhex(c) {
    if (Codepoint.CODES.get("0") <= c && c <= Codepoint.CODES.get("9")) return c - Codepoint.CODES.get("0");
    if (Codepoint.CODES.get("a") <= c && c <= Codepoint.CODES.get("f")) return c - Codepoint.CODES.get("a") + 10;
    if (Codepoint.CODES.get("A") <= c && c <= Codepoint.CODES.get("F")) return c - Codepoint.CODES.get("A") + 10;
    return -1;
  }
  static escapeRune(rune) {
    let out = "";
    if (Unicode.isPrint(rune)) {
      if (Utils2.METACHARACTERS.indexOf(String.fromCodePoint(rune)) >= 0) out += "\\";
      out += String.fromCodePoint(rune);
    } else switch (rune) {
      case Codepoint.CODES.get('"'):
        out += '\\"';
        break;
      case Codepoint.CODES.get("\\"):
        out += "\\\\";
        break;
      case Codepoint.CODES.get("	"):
        out += "\\t";
        break;
      case Codepoint.CODES.get("\n"):
        out += "\\n";
        break;
      case Codepoint.CODES.get("\r"):
        out += "\\r";
        break;
      case Codepoint.CODES.get("\b"):
        out += "\\b";
        break;
      case Codepoint.CODES.get("\f"):
        out += "\\f";
        break;
      default: {
        let s = rune.toString(16);
        if (rune < 256) {
          out += "\\x";
          if (s.length === 1) out += "0";
          out += s;
        } else out += `\\x{${s}}`;
        break;
      }
    }
    return out;
  }
  static stringToRunes(str) {
    const string = String(str);
    const runes = [];
    let i = 0;
    while (i < string.length) {
      const cp = string.codePointAt(i);
      runes.push(cp);
      i += cp > Unicode.MAX_BMP ? 2 : 1;
    }
    return runes;
  }
  static runeToString(r) {
    return String.fromCodePoint(r);
  }
  static isWordRune(r) {
    return r < FAST_PATH_TABLE_SIZE ? WORD_RUNE_TABLE[r] === 1 : false;
  }
  static emptyOpContext(r1, r2) {
    let op = 0;
    if (r1 < 0) op |= Utils2.EMPTY_BEGIN_TEXT | Utils2.EMPTY_BEGIN_LINE;
    if (r1 === 10) op |= Utils2.EMPTY_BEGIN_LINE;
    if (r2 < 0) op |= Utils2.EMPTY_END_TEXT | Utils2.EMPTY_END_LINE;
    if (r2 === 10) op |= Utils2.EMPTY_END_LINE;
    if (Utils2.isWordRune(r1) !== Utils2.isWordRune(r2)) op |= Utils2.EMPTY_WORD_BOUNDARY;
    else op |= Utils2.EMPTY_NO_WORD_BOUNDARY;
    return op;
  }
  /**
  * Returns a string that quotes all regular expression metacharacters inside the argument text;
  * the returned string is a regular expression matching the literal text. For example,
  * {@code quoteMeta("[foo]").equals("\\[foo\\]")}.
  * @param {string} str
  * @returns {string}
  */
  static quoteMeta(str) {
    return str.split("").map((s) => {
      if (Utils2.METACHARACTERS.indexOf(s) >= 0) return `\\${s}`;
      return s;
    }).join("");
  }
  static charCount(codePoint) {
    return codePoint > Unicode.MAX_BMP ? 2 : 1;
  }
  /**
  * High-speed conversion from TypedArrays to standard JS Arrays.
  * Bypasses the expensive Symbol.iterator overhead of Array.from()
  */
  static toArray(typedArray) {
    const len = typedArray.length;
    const res = new Array(len);
    for (let i = 0; i < len; i++) res[i] = typedArray[i];
    return res;
  }
  static stringToUtf8ByteArray(str) {
    if (globalThis.TextEncoder) {
      if (!cachedNativeEncoder) cachedNativeEncoder = new TextEncoder();
      return cachedNativeEncoder.encode(str);
    } else {
      let out = [], p = 0;
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 128) out[p++] = c;
        else if (c < 2048) {
          out[p++] = c >> 6 | 192;
          out[p++] = c & 63 | 128;
        } else if ((c & 64512) === Unicode.MIN_HIGH_SURROGATE && i + 1 < str.length && (str.charCodeAt(i + 1) & 64512) === Unicode.MIN_LOW_SURROGATE) {
          c = Unicode.MIN_SUPPLEMENTARY_CODE_POINT + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023);
          out[p++] = c >> 18 | 240;
          out[p++] = c >> 12 & 63 | 128;
          out[p++] = c >> 6 & 63 | 128;
          out[p++] = c & 63 | 128;
        } else {
          out[p++] = c >> 12 | 224;
          out[p++] = c >> 6 & 63 | 128;
          out[p++] = c & 63 | 128;
        }
      }
      return out;
    }
  }
  static utf8ByteArrayToString(bytes) {
    if (globalThis.TextDecoder) {
      if (!cachedNativeDecoder) cachedNativeDecoder = new TextDecoder("utf-8");
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return cachedNativeDecoder.decode(view);
    } else {
      let out = [], pos = 0, c = 0;
      while (pos < bytes.length) {
        let c1 = bytes[pos++];
        if (c1 < 128) out[c++] = String.fromCharCode(c1);
        else if (c1 > 191 && c1 < 224) {
          let c2 = bytes[pos++];
          out[c++] = String.fromCharCode((c1 & 31) << 6 | c2 & 63);
        } else if (c1 > 239 && c1 < 365) {
          let c2 = bytes[pos++];
          let c3 = bytes[pos++];
          let c4 = bytes[pos++];
          let u = ((c1 & 7) << 18 | (c2 & 63) << 12 | (c3 & 63) << 6 | c4 & 63) - Unicode.MIN_SUPPLEMENTARY_CODE_POINT;
          out[c++] = String.fromCharCode(Unicode.MIN_HIGH_SURROGATE + (u >> 10));
          out[c++] = String.fromCharCode(Unicode.MIN_LOW_SURROGATE + (u & 1023));
        } else {
          let c2 = bytes[pos++];
          let c3 = bytes[pos++];
          out[c++] = String.fromCharCode((c1 & 15) << 12 | (c2 & 63) << 6 | c3 & 63);
        }
      }
      return out.join("");
    }
  }
};
var createEnum = (values = [], initNum = 0) => {
  const enumObject = /* @__PURE__ */ Object.create(null);
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    const keyVal = initNum + i;
    enumObject[val] = keyVal;
    enumObject[keyVal] = val;
  }
  return Object.freeze(enumObject);
};
var MatcherInputBase = class MatcherInputBase2 {
  static Encoding = createEnum(["UTF_16", "UTF_8"]);
  getEncoding() {
    throw Error("not implemented");
  }
  /** @returns {string} */
  asCharSequence() {
    throw Error("not implemented");
  }
  /** @returns {Uint8Array|number[]} */
  asBytes() {
    throw Error("not implemented");
  }
  /** @returns {number} */
  length() {
    throw Error("not implemented");
  }
  /**
  *
  * @returns {boolean}
  */
  isUTF8Encoding() {
    return this.getEncoding() === MatcherInputBase2.Encoding.UTF_8;
  }
  /**
  *
  * @returns {boolean}
  */
  isUTF16Encoding() {
    return this.getEncoding() === MatcherInputBase2.Encoding.UTF_16;
  }
};
var Utf8MatcherInput = class extends MatcherInputBase {
  /** @param {Uint8Array|number[]|null} bytes */
  constructor(bytes = null) {
    super();
    this.bytes = bytes;
  }
  getEncoding() {
    return MatcherInputBase.Encoding.UTF_8;
  }
  /**
  *
  * @returns {string}
  */
  asCharSequence() {
    return Utils.utf8ByteArrayToString(this.bytes);
  }
  /**
  *
  * @returns {Uint8Array|number[]|null}
  */
  asBytes() {
    return this.bytes;
  }
  /**
  *
  * @returns {number}
  */
  length() {
    return this.bytes.length;
  }
};
var Utf16MatcherInput = class extends MatcherInputBase {
  /** @param {string|null} charSequence */
  constructor(charSequence = null) {
    super();
    this.charSequence = charSequence;
  }
  getEncoding() {
    return MatcherInputBase.Encoding.UTF_16;
  }
  /**
  *
  * @returns {string}
  */
  asCharSequence() {
    return this.charSequence;
  }
  /**
  *
  * @returns {number[]}
  */
  asBytes() {
    return Utils.stringToUtf8ByteArray(this.charSequence.toString());
  }
  /**
  *
  * @returns {number}
  */
  length() {
    return this.charSequence.length;
  }
};
var MatcherInput = class {
  /**
  * Return the MatcherInput for UTF_16 encoding.
  * @returns {Utf16MatcherInput}
  */
  static utf16(charSequence) {
    return new Utf16MatcherInput(charSequence);
  }
  /**
  * Return the MatcherInput for UTF_8 encoding.
  * @returns {Utf8MatcherInput}
  */
  static utf8(input) {
    if (Utils.isByteArray(input)) return new Utf8MatcherInput(input);
    return new Utf8MatcherInput(Utils.stringToUtf8ByteArray(input));
  }
};
var MachineInputBase = class {
  static EOF() {
    return -8;
  }
  constructor() {
    this.end = 0;
  }
  canCheckPrefix() {
    return true;
  }
  endPos() {
    return this.end;
  }
  hasString() {
    return false;
  }
  hasAnyString() {
    return false;
  }
  prefixLength() {
    return 0;
  }
};
var MachineUTF8Input = class extends MachineInputBase {
  constructor(bytes, start = 0, end = bytes.length) {
    super();
    this.bytes = bytes;
    this.start = start;
    this.end = end;
  }
  hasString(prefilter, pos) {
    const target = prefilter.bytes;
    if (target.length === 0) return true;
    const idx = this.indexOf(this.bytes, target, this.start + pos);
    return idx !== -1 && idx <= this.end - target.length;
  }
  hasAnyString(prefilter, pos) {
    if (!prefilter.ac8) return false;
    return prefilter.ac8.searchUTF8(this.bytes, this.start + pos, this.end);
  }
  step(pos) {
    pos += this.start;
    if (pos >= this.end) return MachineInputBase.EOF();
    const c = this.bytes[pos] & 255;
    if (c < 128) return c << 3 | 1;
    else if (c >= 194 && c <= 223 && pos + 1 < this.end) {
      const c1 = this.bytes[pos + 1] & 255;
      if ((c1 & 192) !== 128) return c << 3 | 1;
      return ((c & 31) << 6 | c1 & 63) << 3 | 2;
    } else if (c >= 224 && c <= 239 && pos + 2 < this.end) {
      const c1 = this.bytes[pos + 1] & 255;
      if ((c1 & 192) !== 128) return c << 3 | 1;
      const c2 = this.bytes[pos + 2] & 255;
      if ((c2 & 192) !== 128) return c << 3 | 1;
      return ((c & 15) << 12 | (c1 & 63) << 6 | c2 & 63) << 3 | 3;
    } else if (c >= 240 && c <= 244 && pos + 3 < this.end) {
      const c1 = this.bytes[pos + 1] & 255;
      if ((c1 & 192) !== 128) return c << 3 | 1;
      const c2 = this.bytes[pos + 2] & 255;
      if ((c2 & 192) !== 128) return c << 3 | 1;
      const c3 = this.bytes[pos + 3] & 255;
      if ((c3 & 192) !== 128) return c << 3 | 1;
      return ((c & 7) << 18 | (c1 & 63) << 12 | (c2 & 63) << 6 | c3 & 63) << 3 | 4;
    } else return c << 3 | 1;
  }
  index(re2, pos) {
    pos += this.start;
    const i = this.indexOf(this.bytes, re2.prefixUTF8, pos);
    return i < 0 ? i : i - pos;
  }
  context(pos) {
    pos += this.start;
    let r1 = -1;
    if (pos > this.start && pos <= this.end) {
      let start = pos - 1;
      r1 = this.bytes[start--];
      if (r1 >= 128) {
        let lim = pos - 4;
        if (lim < this.start) lim = this.start;
        while (start >= lim && (this.bytes[start] & 192) === 128) start--;
        if (start < this.start) start = this.start;
        r1 = this.step(start - this.start) >> 3;
      }
    }
    const r2 = pos < this.end ? this.step(pos - this.start) >> 3 : -1;
    return Utils.emptyOpContext(r1, r2);
  }
  indexOf(source, target, fromIndex = 0) {
    let targetLength = target.length;
    if (targetLength === 0) return fromIndex <= this.end ? fromIndex : -1;
    const firstByte = target[0];
    let limit = this.end - targetLength;
    const hasNativeIndexOf = typeof source.indexOf === "function";
    let i = fromIndex;
    while (i <= limit) {
      if (hasNativeIndexOf) {
        i = source.indexOf(firstByte, i);
        if (i === -1 || i > limit) return -1;
      } else {
        while (i <= limit && source[i] !== firstByte) i++;
        if (i > limit) return -1;
      }
      let match = true;
      for (let j = 1; j < targetLength; j++) if (source[i + j] !== target[j]) {
        match = false;
        break;
      }
      if (match) return i;
      i++;
    }
    return -1;
  }
  prefixLength(re2) {
    return re2.prefixUTF8.length;
  }
};
var MachineUTF16Input = class extends MachineInputBase {
  constructor(charSequence, start = 0, end = charSequence.length) {
    super();
    this.charSequence = charSequence;
    this.start = start;
    this.end = end;
  }
  hasString(prefilter, pos) {
    const idx = this.charSequence.indexOf(prefilter.str, this.start + pos);
    return idx !== -1 && idx <= this.end - prefilter.str.length;
  }
  hasAnyString(prefilter, pos) {
    if (!prefilter.ac16) return false;
    return prefilter.ac16.searchUTF16(this.charSequence, this.start + pos, this.end);
  }
  step(pos) {
    pos += this.start;
    if (pos >= this.end) return MachineInputBase.EOF();
    const c1 = this.charSequence.charCodeAt(pos);
    if (c1 < Unicode.MIN_HIGH_SURROGATE || c1 > Unicode.MAX_HIGH_SURROGATE || pos + 1 >= this.end) return c1 << 3 | 1;
    const c2 = this.charSequence.charCodeAt(pos + 1);
    if (c2 >= Unicode.MIN_LOW_SURROGATE && c2 <= Unicode.MAX_LOW_SURROGATE) return (c1 - Unicode.MIN_HIGH_SURROGATE) * 1024 + (c2 - Unicode.MIN_LOW_SURROGATE) + Unicode.MIN_SUPPLEMENTARY_CODE_POINT << 3 | 2;
    return c1 << 3 | 1;
  }
  index(re2, pos) {
    pos += this.start;
    const i = this.charSequence.indexOf(re2.prefix, pos);
    if (i < 0 || i > this.end - re2.prefix.length) return -1;
    return i - pos;
  }
  context(pos) {
    pos += this.start;
    const r1 = pos > this.start && pos <= this.end ? this.charSequence.charCodeAt(pos - 1) : -1;
    const r2 = pos < this.end ? this.charSequence.charCodeAt(pos) : -1;
    return Utils.emptyOpContext(r1, r2);
  }
  prefixLength(re2) {
    return re2.prefix.length;
  }
};
var MachineInput = class {
  static fromUTF8(bytes, start = 0, end = bytes.length) {
    return new MachineUTF8Input(bytes, start, end);
  }
  static fromUTF16(charSequence, start = 0, end = charSequence.length) {
    return new MachineUTF16Input(charSequence, start, end);
  }
};
var RE2JSException = class extends Error {
  /** @param {string} message */
  constructor(message2) {
    super(message2);
    this.name = "RE2JSException";
  }
};
var RE2JSSyntaxException = class extends RE2JSException {
  /**
  * @param {string} error
  * @param {string|null} [input=null]
  */
  constructor(error, input = null) {
    let message2 = `error parsing regexp: ${error}`;
    if (input) message2 += `: \`${input}\``;
    super(message2);
    this.name = "RE2JSSyntaxException";
    this.message = message2;
    this.error = error;
    this.input = input;
  }
  /**
  * Retrieves the description of the error.
  * @returns {string}
  */
  getDescription() {
    return this.error;
  }
  /**
  * Retrieves the erroneous regular-expression pattern.
  * @returns {string|null}
  */
  getPattern() {
    return this.input;
  }
};
var RE2JSCompileException = class extends RE2JSException {
  /** @param {string} message */
  constructor(message2) {
    super(message2);
    this.name = "RE2JSCompileException";
  }
};
var RE2JSGroupException = class extends RE2JSException {
  /** @param {string} message */
  constructor(message2) {
    super(message2);
    this.name = "RE2JSGroupException";
  }
};
var RE2JSFlagsException = class extends RE2JSException {
  /** @param {string} message */
  constructor(message2) {
    super(message2);
    this.name = "RE2JSFlagsException";
  }
};
var RE2JSInternalException = class extends RE2JSException {
  /** @param {string} message */
  constructor(message2) {
    super(message2);
    this.name = "RE2JSInternalException";
  }
};
var Matcher = class Matcher2 {
  /**
  * V8 and WebKit have historical hard limits on the number of arguments
  * that can be passed to a function. We cap replacer arguments to prevent
  * Call Stack Overflow (DoS) vulnerabilities on massive ASTs.
  */
  static MAX_REPLACER_ARGS = 65535;
  /**
  * Quotes '\' and '$' in {@code s}, so that the returned string could be used in
  * {@link #appendReplacement} as a literal replacement of {@code s}.
  *
  * @param {string} str the string to be quoted
  * @param {boolean} [javaMode=false] whether the replacement will be used in javaMode
  * @returns {string} the quoted string
  */
  static quoteReplacement(str, javaMode = false) {
    if (javaMode) {
      if (str.indexOf("\\") < 0 && str.indexOf("$") < 0) return str;
      return str.split("").map((s) => {
        const c = s.codePointAt(0);
        if (c === Codepoint.CODES.get("\\") || c === Codepoint.CODES.get("$")) return `\\${s}`;
        return s;
      }).join("");
    }
    if (str.indexOf("$") < 0) return str;
    return str.split("").map((s) => {
      if (s.codePointAt(0) === Codepoint.CODES.get("$")) return "$$";
      return s;
    }).join("");
  }
  /**
  *
  * @param {import('./index.js').RE2JS} pattern
  * @param {string|number[]|Uint8Array|MatcherInputBase} input
  */
  constructor(pattern, input) {
    if (pattern === null) throw new Error("pattern is null");
    this.patternInput = pattern;
    const re2 = this.patternInput.re2();
    this.patternGroupCount = re2.numberOfCapturingGroups();
    this.groups = [];
    this.namedGroups = re2.namedGroups;
    this.numberOfInstructions = re2.numberOfInstructions();
    if (input instanceof MatcherInputBase) this.resetMatcherInput(input);
    else if (Utils.isByteArray(input)) this.resetMatcherInput(MatcherInput.utf8(input));
    else this.resetMatcherInput(MatcherInput.utf16(input));
  }
  /**
  * Returns the {@code RE2JS} associated with this {@code Matcher}.
  * @returns {import('./index.js').RE2JS}
  */
  pattern() {
    return this.patternInput;
  }
  /**
  * Resets the {@code Matcher}, rewinding input and discarding any match information.
  *
  * @returns {Matcher} the {@code Matcher} itself, for chained method calls
  */
  reset() {
    this.matcherInputLength = this.matcherInput.length();
    this.appendPos = 0;
    this.hasMatch = false;
    this.hasGroups = false;
    this.anchorFlag = 0;
    return this;
  }
  /**
  * Resets the {@code Matcher} and changes the input.
  * @param {string|number[]|Uint8Array|MatcherInputBase} input
  * @returns {Matcher} the {@code Matcher} itself, for chained method calls
  */
  resetMatcherInput(input) {
    if (input === null) throw new Error("input is null");
    if (!(input instanceof MatcherInputBase)) if (Utils.isByteArray(input)) input = MatcherInput.utf8(input);
    else input = MatcherInput.utf16(input);
    this.matcherInput = input;
    this.reset();
    return this;
  }
  /**
  * Returns the start of the named group of the most recent match, or -1 if the group was not
  * matched.
  * @param {string|number} [group=0]
  * @returns {number}
  */
  start(group = 0) {
    if (typeof group === "string") {
      const groupInt = this.namedGroups[group];
      if (!Number.isFinite(groupInt)) throw new RE2JSGroupException(`group '${group}' not found`);
      group = groupInt;
    }
    this.loadGroup(group);
    return this.groups[2 * group];
  }
  /**
  * Returns the end of the named group of the most recent match, or -1 if the group was not
  * matched.
  * @param {string|number} [group=0]
  * @returns {number}
  */
  end(group = 0) {
    if (typeof group === "string") {
      const groupInt = this.namedGroups[group];
      if (!Number.isFinite(groupInt)) throw new RE2JSGroupException(`group '${group}' not found`);
      group = groupInt;
    }
    this.loadGroup(group);
    return this.groups[2 * group + 1];
  }
  /**
  * Returns the program size of this pattern.
  *
  * <p>
  * Similar to the C++ implementation, the program size is a very approximate measure of a regexp's
  * "cost". Larger numbers are more expensive than smaller numbers.
  * </p>
  *
  * @returns {number} the program size of this pattern
  */
  programSize() {
    return this.numberOfInstructions;
  }
  /**
  * Returns the named group of the most recent match, or {@code null} if the group was not matched.
  * @param {string|number} [group=0]
  * @returns {string|null}
  */
  group(group = 0) {
    if (typeof group === "string") {
      const groupInt = this.namedGroups[group];
      if (!Number.isFinite(groupInt)) throw new RE2JSGroupException(`group '${group}' not found`);
      group = groupInt;
    }
    const start = this.start(group);
    const end = this.end(group);
    if (start < 0 && end < 0) return null;
    return this.substring(start, end);
  }
  /**
  * Returns a dictionary map of all named capturing groups and their matched values.
  * If a group was not matched, its value will be `null`.
  * @returns {Record<string, string|null>}
  */
  getNamedGroups() {
    if (!this.hasMatch) throw new RE2JSGroupException("perhaps no match attempted");
    const result = /* @__PURE__ */ Object.create(null);
    for (const name of Object.keys(this.namedGroups)) result[name] = this.group(name);
    return result;
  }
  /**
  * Returns the number of subgroups in this pattern.
  *
  * @returns {number} the number of subgroups; the overall match (group 0) does not count
  */
  groupCount() {
    return this.patternGroupCount;
  }
  /**
  * Helper: finds subgroup information if needed for group.
  * @param {number} group
  * @private
  */
  loadGroup(group) {
    if (group < 0 || group > this.patternGroupCount) throw new RE2JSGroupException(`Group index out of bounds: ${group}`);
    if (!this.hasMatch) throw new RE2JSGroupException("perhaps no match attempted");
    if (group === 0 || this.hasGroups) return;
    const end = this.matcherInputLength;
    const res = this.patternInput.re2().matchMachineInput(this.matcherInput, this.groups[0], end, this.anchorFlag, 1 + this.patternGroupCount);
    if (!res[0]) throw new RE2JSGroupException("inconsistency in matching group data");
    this.groups = res[1];
    this.hasGroups = true;
  }
  /**
  * Matches the entire input against the pattern (anchored start and end). If there is a match,
  * {@code matches} sets the match state to describe it.
  *
  * @returns {boolean} true if the entire input matches the pattern
  */
  matches() {
    return this.genMatch(0, RE2Flags.ANCHOR_BOTH);
  }
  /**
  * Matches the beginning of input against the pattern (anchored start). If there is a match,
  * {@code lookingAt} sets the match state to describe it.
  *
  * @returns {boolean} true if the beginning of the input matches the pattern
  */
  lookingAt() {
    return this.genMatch(0, RE2Flags.ANCHOR_START);
  }
  /**
  * Matches the input against the pattern (unanchored), starting at a specified position. If there
  * is a match, {@code find} sets the match state to describe it.
  *
  * @param {number|null} [start=null] the input position where the search begins
  * @returns {boolean} if it finds a match
  * @throws IndexOutOfBoundsException if start is not a valid input position
  */
  find(start = null) {
    if (start !== null) {
      if (start < 0 || start > this.matcherInputLength) throw new RE2JSGroupException(`start index out of bounds: ${start}`);
      this.reset();
      return this.genMatch(start, 0);
    }
    start = 0;
    if (this.hasMatch) {
      start = this.groups[1];
      if (this.groups[0] === this.groups[1]) {
        const r = (this.matcherInput.isUTF16Encoding() ? MachineInput.fromUTF16(this.matcherInput.asCharSequence(), 0, this.matcherInputLength) : MachineInput.fromUTF8(this.matcherInput.asBytes(), 0, this.matcherInputLength)).step(start);
        if (r < 0) start++;
        else start += r & 7;
      }
    }
    return this.genMatch(start, RE2Flags.UNANCHORED);
  }
  /**
  * Helper: does match starting at start, with RE2 anchor flag.
  * @param {number} startByte
  * @param {number} anchor
  * @returns {boolean}
  * @private
  */
  genMatch(startByte, anchor) {
    const res = this.patternInput.re2().matchMachineInput(this.matcherInput, startByte, this.matcherInputLength, anchor, 1);
    if (!res[0]) {
      this.hasMatch = false;
      return false;
    }
    this.groups = res[1];
    this.hasMatch = true;
    this.hasGroups = this.patternGroupCount === 0;
    this.anchorFlag = anchor;
    return true;
  }
  /**
  * Helper: return substring for [start, end).
  * @param {number} start
  * @param {number} end
  * @returns {string}
  */
  substring(start, end) {
    if (this.matcherInput.isUTF8Encoding()) return Utils.utf8ByteArrayToString(this.matcherInput.asBytes().slice(start, end));
    return this.matcherInput.asCharSequence().substring(start, end).toString();
  }
  /**
  * Helper for Pattern: return input length.
  * @returns {number}
  */
  inputLength() {
    return this.matcherInputLength;
  }
  /**
  * Appends to result two strings: the text from the append position up to the beginning of the
  * most recent match, and then the replacement with submatch groups substituted for references of
  * the form {@code $n}, where {@code n} is the group number in decimal. It advances the append
  * position to where the most recent match ended.
  *
  * To embed a literal {@code $}, use \$ (actually {@code "\\$"} with string escapes). The escape
  * is only necessary when {@code $} is followed by a digit, but it is always allowed. Only
  * {@code $} and {@code \} need escaping, but any character can be escaped.
  *
  * The group number {@code n} in {@code $n} is always at least one digit and expands to use more
  * digits as long as the resulting number is a valid group number for this pattern. To cut it off
  * earlier, escape the first digit that should not be used.
  *
  * @param {string} replacement the replacement string
  * @param {boolean} [javaMode=false] activate java mode (different behaviour for capture groups and special characters)
  * @returns {string}
  * @throws IllegalStateException if there was no most recent match
  * @throws IndexOutOfBoundsException if replacement refers to an invalid group
  * @private
  */
  appendReplacement(replacement, javaMode = false) {
    let res = "";
    const s = this.start();
    const e = this.end();
    if (this.appendPos < s) res += this.substring(this.appendPos, s);
    this.appendPos = e;
    res += javaMode ? this.appendReplacementInternalJava(replacement) : this.appendReplacementInternalJs(replacement);
    return res;
  }
  /**
  * @param {string} replacement - the replacement string
  * @returns {string}
  * @private
  */
  appendReplacementInternalJava(replacement) {
    let res = "";
    let last = 0;
    const m = replacement.length;
    let i = 0;
    while (i < m) {
      const cCode = replacement.codePointAt(i);
      if (cCode === Codepoint.CODES.get("\\")) {
        if (last < i) res += replacement.substring(last, i);
        i++;
        if (i >= m) throw new RE2JSGroupException("character to be escaped is missing");
        last = i;
        i++;
        continue;
      }
      if (cCode === Codepoint.CODES.get("$")) {
        if (last < i) res += replacement.substring(last, i);
        if (i + 1 >= m) throw new RE2JSGroupException("Illegal group reference: group index is missing");
        const nextCode = replacement.codePointAt(i + 1);
        if (Codepoint.CODES.get("0") <= nextCode && nextCode <= Codepoint.CODES.get("9")) {
          let n = nextCode - Codepoint.CODES.get("0");
          let j = i + 2;
          for (; j < m; j++) {
            const digit = replacement.codePointAt(j);
            if (digit < Codepoint.CODES.get("0") || digit > Codepoint.CODES.get("9") || n * 10 + digit - Codepoint.CODES.get("0") > this.patternGroupCount) break;
            n = n * 10 + digit - Codepoint.CODES.get("0");
          }
          if (n > this.patternGroupCount) throw new RE2JSGroupException(`n > number of groups: ${n}`);
          const group = this.group(n);
          if (group !== null) res += group;
          i = j;
          last = i;
        } else if (nextCode === Codepoint.CODES.get("{")) {
          let j = i + 2;
          while (j < m && replacement.codePointAt(j) !== Codepoint.CODES.get("}")) j++;
          if (j >= m) throw new RE2JSGroupException("named capture group is missing trailing '}'");
          const groupName = replacement.substring(i + 2, j);
          const groupVal = this.group(groupName);
          if (groupVal !== null) res += groupVal;
          i = j + 1;
          last = i;
        } else throw new RE2JSGroupException("Illegal group reference");
        continue;
      }
      i++;
    }
    if (last < m) res += replacement.substring(last, m);
    return res;
  }
  /**
  * @param {string} replacement - the replacement string
  * @returns {string}
  * @private
  */
  appendReplacementInternalJs(replacement) {
    let res = "";
    let last = 0;
    const m = replacement.length;
    for (let i = 0; i < m - 1; i++) if (replacement.codePointAt(i) === Codepoint.CODES.get("$")) {
      let c = replacement.codePointAt(i + 1);
      if (Codepoint.CODES.get("$") === c) {
        if (last < i) res += replacement.substring(last, i);
        res += "$";
        i++;
        last = i + 1;
        continue;
      } else if (Codepoint.CODES.get("&") === c) {
        if (last < i) res += replacement.substring(last, i);
        const group = this.group(0);
        if (group !== null) res += group;
        else res += "$&";
        i++;
        last = i + 1;
        continue;
      } else if (Codepoint.CODES.get("`") === c) {
        if (last < i) res += replacement.substring(last, i);
        res += this.substring(0, this.start(0));
        i++;
        last = i + 1;
        continue;
      } else if (Codepoint.CODES.get("'") === c) {
        if (last < i) res += replacement.substring(last, i);
        res += this.substring(this.end(0), this.matcherInputLength);
        i++;
        last = i + 1;
        continue;
      } else if (Codepoint.CODES.get("1") <= c && c <= Codepoint.CODES.get("9")) {
        let n = c - Codepoint.CODES.get("0");
        if (last < i) res += replacement.substring(last, i);
        for (i += 2; i < m; i++) {
          c = replacement.codePointAt(i);
          if (c < Codepoint.CODES.get("0") || c > Codepoint.CODES.get("9") || n * 10 + c - Codepoint.CODES.get("0") > this.patternGroupCount) break;
          n = n * 10 + c - Codepoint.CODES.get("0");
        }
        if (n > this.patternGroupCount) {
          res += `$${n}`;
          last = i;
          i--;
          continue;
        }
        const group = this.group(n);
        if (group !== null) res += group;
        last = i;
        i--;
        continue;
      } else if (c === Codepoint.CODES.get("<")) {
        if (last < i) res += replacement.substring(last, i);
        i++;
        let j = i + 1;
        while (j < replacement.length && replacement.codePointAt(j) !== Codepoint.CODES.get(">") && replacement.codePointAt(j) !== Codepoint.CODES.get(" ")) j++;
        if (j === replacement.length || replacement.codePointAt(j) !== Codepoint.CODES.get(">")) {
          res += replacement.substring(i - 1, j + 1);
          last = j + 1;
          i = j;
          continue;
        }
        const groupName = replacement.substring(i + 1, j);
        if (Object.prototype.hasOwnProperty.call(this.namedGroups, groupName)) {
          const groupVal = this.group(groupName);
          if (groupVal !== null) res += groupVal;
        } else res += `$<${groupName}>`;
        last = j + 1;
        i = j;
        continue;
      }
    }
    if (last < m) res += replacement.substring(last, m);
    return res;
  }
  /**
  * Return the substring of the input from the append position to the end of the
  * input.
  * @returns {string}
  */
  appendTail() {
    return this.substring(this.appendPos, this.matcherInputLength);
  }
  /**
  * Returns the input with all matches replaced by {@code replacement}, interpreted as for
  * {@code appendReplacement}.
  *
  * @param {string|((...args: any[]) => string)} replacement - the replacement string or a replacer function
  * @param {boolean} [javaMode=false] - activate java mode (different behaviour for capture groups and special characters)
  * @returns {string} the input string with the matches replaced
  * @throws IndexOutOfBoundsException if replacement refers to an invalid group and javaMode is true
  */
  replaceAll(replacement, javaMode = false) {
    return this.replace(replacement, true, javaMode);
  }
  /**
  * Returns the input with the first match replaced by {@code replacement}, interpreted as for
  * {@code appendReplacement}.
  *
  * @param {string|((...args: any[]) => string)} replacement - the replacement string or a replacer function
  * @param {boolean} [javaMode=false] - activate java mode (different behaviour for capture groups and special characters)
  * @returns {string} the input string with the first match replaced
  * @throws IndexOutOfBoundsException if replacement refers to an invalid group and javaMode is true
  */
  replaceFirst(replacement, javaMode = false) {
    return this.replace(replacement, false, javaMode);
  }
  /**
  * Helper: replaceAll/replaceFirst hybrid.
  * @param {string|((...args: any[]) => string)} replacement - the replacement string or a replacer function
  * @param {boolean} [all=true] - replace all matches
  * @param {boolean} [javaMode=false] - activate java mode (different behaviour for capture groups and special characters)
  * @returns {string}
  * @private
  */
  replace(replacement, all = true, javaMode = false) {
    let res = "";
    this.reset();
    const isFunc = typeof replacement === "function";
    const hasNamedGroups = Object.keys(this.namedGroups).length > 0;
    let originalInput = null;
    if (isFunc) {
      if (this.groupCount() >= Matcher2.MAX_REPLACER_ARGS) throw new RE2JSGroupException("Too many capture groups to safely invoke replacer function");
      originalInput = this.matcherInput.isUTF8Encoding() ? this.matcherInput.asBytes() : this.matcherInput.asCharSequence();
    }
    while (this.find()) {
      res += isFunc ? this.appendReplacementFunc(replacement, hasNamedGroups, originalInput) : this.appendReplacement(replacement, javaMode);
      if (!all) break;
    }
    res += this.appendTail();
    return res;
  }
  /**
  * Evaluates a replacer function for the current match and appends the result,
  * along with any un-matched preceding text, advancing the append position.
  * @param {Function} replacer - the replacer function
  * @param {boolean} hasNamedGroups - cached flag if pattern has named groups
  * @param {string|Uint8Array|number[]} originalInput - the cached original input reference
  * @returns {string} the evaluated string to append
  * @private
  */
  appendReplacementFunc(replacer, hasNamedGroups, originalInput) {
    let res = "";
    const s = this.start();
    const e = this.end();
    if (this.appendPos < s) res += this.substring(this.appendPos, s);
    this.appendPos = e;
    const args = this.buildReplacerArgs(s, hasNamedGroups, originalInput);
    res += String(replacer(...args));
    return res;
  }
  /**
  * Builds the argument array for the replacer function matching the standard
  * JS String.prototype.replace(regex, replacer) signature.
  * @param {number} matchStart - the start index of the match
  * @param {boolean} hasNamedGroups - cached flag if pattern has named groups
  * @param {string|Uint8Array|number[]} originalInput - the cached original input reference
  * @returns {Array} array of arguments
  * @private
  */
  buildReplacerArgs(matchStart, hasNamedGroups, originalInput) {
    const args = [this.group(0)];
    const numGroups = this.groupCount();
    for (let i = 1; i <= numGroups; i++) {
      const start = this.start(i);
      if (start < 0) args.push(void 0);
      else args.push(this.substring(start, this.end(i)));
    }
    args.push(matchStart);
    args.push(originalInput);
    if (hasNamedGroups) {
      const parsedGroups = this.getNamedGroups();
      for (const key in parsedGroups) if (parsedGroups[key] === null) parsedGroups[key] = void 0;
      args.push(parsedGroups);
    }
    return args;
  }
};
var Inst = class Inst2 {
  static ALT = 1;
  static ALT_MATCH = 2;
  static CAPTURE = 3;
  static EMPTY_WIDTH = 4;
  static FAIL = 5;
  static MATCH = 6;
  static NOP = 7;
  static RUNE = 8;
  static RUNE1 = 9;
  static RUNE_ANY = 10;
  static RUNE_ANY_NOT_NL = 11;
  static LB_WRITE = 12;
  static LB_CHECK = 13;
  static isRuneOp(op) {
    return Inst2.RUNE <= op && op <= Inst2.RUNE_ANY_NOT_NL;
  }
  static escapeRunes(runes) {
    let out = '"';
    for (let rune of runes) out += Utils.escapeRune(rune);
    out += '"';
    return out;
  }
  constructor(op) {
    this.op = op;
    this.out = 0;
    this.arg = 0;
    this.runes = [];
    this.next = null;
  }
  matchRune(r) {
    if (this.runes.length === 1) {
      const r0 = this.runes[0];
      if ((this.arg & RE2Flags.FOLD_CASE) !== 0) return Unicode.equalsIgnoreCase(r0, r);
      return r === r0;
    }
    const len = this.runes.length;
    if (len === 0) return false;
    if (len === 2 || len === 4 || len === 6 || len === 8) {
      for (let j = 0; j < len; j += 2) {
        if (r < this.runes[j]) return false;
        if (r <= this.runes[j + 1]) return true;
      }
      return false;
    }
    let base = 0;
    let n = len >> 1;
    while (n > 1) {
      const half = n >> 1;
      base += this.runes[base + half << 1] <= r ? half : 0;
      n -= half;
    }
    base += this.runes[base << 1] <= r ? 1 : 0;
    const m = base - 1;
    return m >= 0 && r <= this.runes[m << 1 | 1];
  }
  matchRunePos(r) {
    if (this.runes.length === 1) {
      const r0 = this.runes[0];
      if ((this.arg & RE2Flags.FOLD_CASE) !== 0) return Unicode.equalsIgnoreCase(r0, r) ? 0 : -1;
      return r === r0 ? 0 : -1;
    }
    const len = this.runes.length;
    if (len === 0) return -1;
    if (len === 2 || len === 4 || len === 6 || len === 8) {
      for (let j = 0; j < len; j += 2) {
        if (r < this.runes[j]) return -1;
        if (r <= this.runes[j + 1]) return Math.floor(j / 2);
      }
      return -1;
    }
    let base = 0;
    let n = len >> 1;
    while (n > 1) {
      const half = n >> 1;
      base += this.runes[base + half << 1] <= r ? half : 0;
      n -= half;
    }
    base += this.runes[base << 1] <= r ? 1 : 0;
    const m = base - 1;
    return m >= 0 && r <= this.runes[m << 1 | 1] ? m : -1;
  }
  /**
  *
  * @returns {string}
  */
  toString() {
    switch (this.op) {
      case Inst2.ALT:
        return `alt -> ${this.out}, ${this.arg}`;
      case Inst2.ALT_MATCH:
        return `altmatch -> ${this.out}, ${this.arg}`;
      case Inst2.CAPTURE:
        return `cap ${this.arg} -> ${this.out}`;
      case Inst2.EMPTY_WIDTH:
        return `empty ${this.arg} -> ${this.out}`;
      case Inst2.MATCH:
        return `match${this.arg !== 0 ? ` ${this.arg}` : ""}`;
      case Inst2.FAIL:
        return "fail";
      case Inst2.NOP:
        return `nop -> ${this.out}`;
      case Inst2.LB_WRITE:
        return `lbwrite ${this.arg} -> ${this.out}`;
      case Inst2.LB_CHECK:
        return `lbcheck ${this.arg} -> ${this.out}`;
      case Inst2.RUNE:
        if (this.runes === null) return "rune <null>";
        return [
          "rune ",
          Inst2.escapeRunes(this.runes),
          (this.arg & RE2Flags.FOLD_CASE) !== 0 ? "/i" : "",
          " -> ",
          this.out
        ].join("");
      case Inst2.RUNE1:
        return `rune1 ${Inst2.escapeRunes(this.runes)} -> ${this.out}`;
      case Inst2.RUNE_ANY:
        return `any -> ${this.out}`;
      case Inst2.RUNE_ANY_NOT_NL:
        return `anynotnl -> ${this.out}`;
      default:
        throw new Error("unhandled case in Inst.toString");
    }
  }
};
var Queue = class {
  constructor(numInst) {
    this.sparse = new Int32Array(numInst);
    this.densePcs = new Int32Array(numInst);
    this.denseCaps = null;
    this.size = 0;
    this.ncap = 0;
  }
  init(ncap) {
    this.ncap = ncap;
    const needed = this.densePcs.length * ncap;
    if (!this.denseCaps || this.denseCaps.length < needed) this.denseCaps = new Int32Array(needed);
  }
  contains(pc) {
    const j = this.sparse[pc];
    return j < this.size && this.densePcs[j] === pc;
  }
  isEmpty() {
    return this.size === 0;
  }
  add(pc) {
    const j = this.size++;
    this.sparse[pc] = j;
    this.densePcs[j] = pc;
    return j;
  }
  clear() {
    this.size = 0;
  }
  toString() {
    let out = "{";
    for (let i = 0; i < this.size; i++) {
      if (i !== 0) out += ", ";
      out += this.densePcs[i];
    }
    out += "}";
    return out;
  }
};
var Machine = class Machine2 {
  static fromRE2(re2) {
    const m = new Machine2();
    m.prog = re2.prog;
    m.re2 = re2;
    m.q0 = new Queue(m.prog.numInst());
    m.q1 = new Queue(m.prog.numInst());
    m.matched = false;
    m.matchcap = new Int32Array(m.prog.numCap < 2 ? 2 : m.prog.numCap);
    m.ncap = 0;
    return m;
  }
  static fromMachine(machine) {
    return Machine2.fromRE2(machine.re2);
  }
  constructor() {
    this.prog = null;
    this.re2 = null;
    this.q0 = null;
    this.q1 = null;
    this.matched = false;
    this.matchcap = null;
    this.ncap = 0;
    this.lbTable = null;
  }
  init(ncap) {
    this.ncap = ncap;
    if (ncap > this.matchcap.length) this.matchcap = new Int32Array(ncap).fill(-1);
    else this.matchcap.fill(-1);
    this.q0.init(ncap);
    this.q1.init(ncap);
    if (this.prog.numLb > 0) {
      if (!this.lbTable || this.lbTable.length < this.prog.numLb + 1) this.lbTable = new Int32Array(this.prog.numLb + 1);
      this.lbTable.fill(-1);
    }
  }
  submatches() {
    if (this.ncap === 0) return Utils.emptyInts();
    return Utils.toArray(this.matchcap.subarray(0, this.ncap));
  }
  match(input, pos, anchor) {
    const startCond = this.re2.cond;
    if (startCond === Utils.EMPTY_ALL) return false;
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return false;
    this.matched = false;
    this.matchcap.fill(-1);
    let currentPos = this.prog.numLb > 0 ? 0 : pos;
    let matchStartPos = pos;
    let runq = this.q0;
    let nextq = this.q1;
    let r = input.step(currentPos);
    let rune = r >> 3;
    let width = r & 7;
    let rune1 = -1;
    let width1 = 0;
    if (r !== MachineInputBase.EOF()) {
      r = input.step(currentPos + width);
      rune1 = r >> 3;
      width1 = r & 7;
    }
    let flag;
    if (currentPos === 0) flag = Utils.emptyOpContext(-1, rune);
    else flag = input.context(currentPos);
    while (true) {
      if (runq.isEmpty()) {
        if ((startCond & Utils.EMPTY_BEGIN_TEXT) !== 0 && currentPos !== 0) break;
        if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && currentPos !== 0) break;
        if (this.matched) break;
        if (this.prog.numLb === 0 && !(this.re2.prefix.length === 0) && rune1 !== this.re2.prefixRune && input.canCheckPrefix()) {
          const advance = input.index(this.re2, currentPos);
          if (advance < 0) break;
          currentPos += advance;
          r = input.step(currentPos);
          rune = r >> 3;
          width = r & 7;
          r = input.step(currentPos + width);
          rune1 = r >> 3;
          width1 = r & 7;
          flag = input.context(currentPos);
        }
      }
      if (currentPos === 0 && this.prog.numLb > 0) for (let i = 0; i < this.prog.lbStarts.length; i++) this.add(runq, this.prog.lbStarts[i], currentPos, this.matchcap, 0, flag);
      if (!this.matched && (currentPos === 0 || anchor === RE2Flags.UNANCHORED)) {
        if (currentPos >= matchStartPos) {
          if (this.ncap > 0) this.matchcap[0] = currentPos;
          this.add(runq, this.prog.start, currentPos, this.matchcap, 0, flag);
        }
      }
      const nextPos = currentPos + width;
      flag = input.context(nextPos);
      this.step(runq, nextq, currentPos, nextPos, rune, flag, anchor, currentPos === input.endPos());
      if (width === 0) break;
      if (this.ncap === 0 && this.matched) break;
      currentPos += width;
      rune = rune1;
      width = width1;
      if (rune !== -1) {
        r = input.step(currentPos + width);
        rune1 = r >> 3;
        width1 = r & 7;
      }
      const tmpq = runq;
      runq = nextq;
      nextq = tmpq;
    }
    nextq.clear();
    return this.matched;
  }
  matchSet(input, pos, anchor) {
    const startCond = this.re2.cond;
    if (startCond === Utils.EMPTY_ALL) return [];
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return [];
    let currentPos = this.prog.numLb > 0 ? 0 : pos;
    let matchStartPos = pos;
    let runq = this.q0;
    let nextq = this.q1;
    let r = input.step(currentPos);
    let rune = r >> 3;
    let width = r & 7;
    let rune1 = -1;
    let width1 = 0;
    if (r !== MachineInputBase.EOF()) {
      r = input.step(currentPos + width);
      rune1 = r >> 3;
      width1 = r & 7;
    }
    let flag = currentPos === 0 ? Utils.emptyOpContext(-1, rune) : input.context(currentPos);
    const matches = /* @__PURE__ */ new Set();
    while (true) {
      if (runq.isEmpty()) {
        if ((startCond & Utils.EMPTY_BEGIN_TEXT) !== 0 && currentPos !== 0) break;
        if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && currentPos !== 0) break;
      }
      if (currentPos === 0 && this.prog.numLb > 0) for (let i = 0; i < this.prog.lbStarts.length; i++) this.add(runq, this.prog.lbStarts[i], currentPos, this.matchcap, 0, flag);
      if (currentPos === 0 || anchor === RE2Flags.UNANCHORED) {
        if (currentPos >= matchStartPos) this.add(runq, this.prog.start, currentPos, this.matchcap, 0, flag);
      }
      const nextPos = currentPos + width;
      flag = input.context(nextPos);
      for (let j = 0; j < runq.size; j++) {
        const pc = runq.densePcs[j];
        const i = this.prog.inst[pc];
        const capOffset = j * this.ncap;
        let add = false;
        switch (i.op) {
          case Inst.MATCH:
            if (anchor === RE2Flags.ANCHOR_BOTH && currentPos !== input.endPos()) break;
            matches.add(i.arg);
            break;
          case Inst.RUNE:
            add = i.matchRune(rune);
            break;
          case Inst.RUNE1:
            add = rune === i.runes[0];
            break;
          case Inst.RUNE_ANY:
            add = true;
            break;
          case Inst.RUNE_ANY_NOT_NL:
            add = rune !== 10;
            break;
          default:
            continue;
        }
        if (add) this.add(nextq, i.out, nextPos, runq.denseCaps, capOffset, flag);
      }
      runq.clear();
      if (width === 0) break;
      currentPos += width;
      rune = rune1;
      width = width1;
      if (rune !== -1) {
        r = input.step(currentPos + width);
        rune1 = r >> 3;
        width1 = r & 7;
      }
      const tmpq = runq;
      runq = nextq;
      nextq = tmpq;
    }
    nextq.clear();
    return Array.from(matches).sort((a, b) => a - b);
  }
  step(runq, nextq, pos, nextPos, c, nextCond, anchor, atEnd) {
    const longest = this.re2.longest;
    for (let j = 0; j < runq.size; j++) {
      const pc = runq.densePcs[j];
      const capOffset = j * this.ncap;
      if (longest && this.matched && this.ncap > 0 && this.matchcap[0] < runq.denseCaps[capOffset]) continue;
      const i = this.prog.inst[pc];
      let add = false;
      switch (i.op) {
        case Inst.MATCH:
          if (anchor === RE2Flags.ANCHOR_BOTH && !atEnd) break;
          if (this.ncap > 0 && (!longest || !this.matched || this.matchcap[1] < pos)) {
            runq.denseCaps[capOffset + 1] = pos;
            for (let k = 0; k < this.ncap; k++) this.matchcap[k] = runq.denseCaps[capOffset + k];
          }
          if (!longest) runq.size = 0;
          this.matched = true;
          break;
        case Inst.RUNE:
          add = i.matchRune(c);
          break;
        case Inst.RUNE1:
          add = c === i.runes[0];
          break;
        case Inst.RUNE_ANY:
          add = true;
          break;
        case Inst.RUNE_ANY_NOT_NL:
          add = c !== 10;
          break;
        default:
          continue;
      }
      if (add) this.add(nextq, i.out, nextPos, runq.denseCaps, capOffset, nextCond);
    }
    runq.clear();
  }
  add(q, pc, pos, capArray, capOffset, cond) {
    while (true) {
      if (pc === 0) return;
      if (q.contains(pc)) return;
      const d = q.add(pc);
      const inst = this.prog.inst[pc];
      switch (inst.op) {
        case Inst.FAIL:
          return;
        case Inst.ALT:
        case Inst.ALT_MATCH:
          this.add(q, inst.out, pos, capArray, capOffset, cond);
          pc = inst.arg;
          continue;
        case Inst.EMPTY_WIDTH:
          if ((inst.arg & ~cond) === 0) {
            pc = inst.out;
            continue;
          }
          return;
        case Inst.NOP:
          pc = inst.out;
          continue;
        case Inst.CAPTURE:
          if (inst.arg < this.ncap) {
            const opos = capArray[capOffset + inst.arg];
            capArray[capOffset + inst.arg] = pos;
            this.add(q, inst.out, pos, capArray, capOffset, cond);
            capArray[capOffset + inst.arg] = opos;
            return;
          } else {
            pc = inst.out;
            continue;
          }
        case Inst.LB_WRITE:
          this.lbTable[Math.abs(inst.arg)] = pos;
          pc = inst.out;
          continue;
        case Inst.LB_CHECK:
          if (inst.arg > 0) {
            if (this.lbTable[inst.arg] === pos) {
              pc = inst.out;
              continue;
            }
          } else if (this.lbTable[-inst.arg] !== pos) {
            pc = inst.out;
            continue;
          }
          return;
        case Inst.MATCH:
        case Inst.RUNE:
        case Inst.RUNE1:
        case Inst.RUNE_ANY:
        case Inst.RUNE_ANY_NOT_NL:
          if (this.ncap > 0) {
            const destOffset = d * this.ncap;
            for (let c = 0; c < this.ncap; c++) q.denseCaps[destOffset + c] = capArray[capOffset + c];
          }
          return;
        default:
          throw new RE2JSInternalException("unhandled");
      }
    }
  }
};
var hashPCs = (pcs) => {
  let h = -2128831035;
  for (let i = 0; i < pcs.length; i++) {
    h ^= pcs[i];
    h = Math.imul(h, 16777619);
  }
  return h;
};
var arraysEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
var DFAState = class {
  constructor(nfaStates, isMatch, matchIDs = []) {
    this.nfaStates = nfaStates;
    this.isMatch = isMatch;
    this.matchIDs = matchIDs;
    this.nextLatin1 = new Array(Unicode.MAX_LATIN1 + 1).fill(null);
    this.nextLatin1Anchored = new Array(Unicode.MAX_LATIN1 + 1).fill(null);
    this.transKeys = [];
    this.transVals = [];
    this.lastSeen = 0;
  }
};
var DFA = class DFA2 {
  static MAX_CACHE_CLEARS = 5;
  static STATE_MEMORY_ESTIMATE = 838;
  constructor(prog, maxMem = 8388608) {
    this.prog = prog;
    this.stateCache = /* @__PURE__ */ new Map();
    this.stateCount = 0;
    this.startState = null;
    this.stateLimit = Math.max(1, Math.floor(maxMem / DFA2.STATE_MEMORY_ESTIMATE));
    this.cacheClears = 0;
    this.failed = false;
    this.clock = 0;
  }
  computeClosure(pcs) {
    const closure = /* @__PURE__ */ new Set();
    const stack = [...pcs];
    let isMatch = false;
    const matchIDs = [];
    while (stack.length > 0) {
      const pc = stack.pop();
      if (closure.has(pc)) continue;
      closure.add(pc);
      const inst = this.prog.getInst(pc);
      switch (inst.op) {
        case Inst.MATCH:
          isMatch = true;
          if (!matchIDs.includes(inst.arg)) matchIDs.push(inst.arg);
          break;
        case Inst.ALT:
        case Inst.ALT_MATCH:
          stack.push(inst.out);
          stack.push(inst.arg);
          break;
        case Inst.NOP:
        case Inst.CAPTURE:
          stack.push(inst.out);
          break;
        case Inst.EMPTY_WIDTH:
        case Inst.LB_WRITE:
        case Inst.LB_CHECK:
          return null;
      }
    }
    const sortedPCs = Int32Array.from(closure).sort();
    matchIDs.sort((a, b) => a - b);
    return {
      pcs: sortedPCs,
      isMatch,
      matchIDs
    };
  }
  getState(pcs) {
    const closureResult = this.computeClosure(pcs);
    if (!closureResult) return null;
    const sortedPCs = closureResult.pcs;
    const hash = hashPCs(sortedPCs);
    let bucket = this.stateCache.get(hash);
    if (bucket) for (let i = 0; i < bucket.length; i++) {
      const state2 = bucket[i];
      if (arraysEqual(state2.nfaStates, sortedPCs)) {
        state2.lastSeen = ++this.clock;
        return state2;
      }
    }
    else {
      bucket = [];
      this.stateCache.set(hash, bucket);
    }
    if (this.failed) return null;
    if (this.stateCount >= this.stateLimit) {
      this.cacheClears++;
      if (this.cacheClears >= DFA2.MAX_CACHE_CLEARS) {
        this.failed = true;
        this.stateCache.clear();
        this.stateCount = 0;
        this.startState = null;
        return null;
      }
      this.evictCache();
      bucket = this.stateCache.get(hash);
      if (!bucket) {
        bucket = [];
        this.stateCache.set(hash, bucket);
      }
    }
    const state = new DFAState(sortedPCs, closureResult.isMatch, closureResult.matchIDs);
    state.lastSeen = ++this.clock;
    bucket.push(state);
    this.stateCount++;
    return state;
  }
  evictCache() {
    const allStates = [];
    for (const bucket of this.stateCache.values()) for (let i = 0; i < bucket.length; i++) allStates.push(bucket[i]);
    allStates.sort((a, b) => a.lastSeen - b.lastSeen);
    const keepCount = Math.max(1, Math.floor(this.stateLimit / 2));
    const startIndex = allStates.length - keepCount;
    const survivorsArray = allStates.slice(startIndex);
    const survivors = new Set(survivorsArray);
    this.stateCache.clear();
    this.stateCount = 0;
    for (let i = 0; i < survivorsArray.length; i++) {
      const state = survivorsArray[i];
      state.nextLatin1.fill(null);
      state.nextLatin1Anchored.fill(null);
      state.transKeys.length = 0;
      state.transVals.length = 0;
      const hash = hashPCs(state.nfaStates);
      let bucket = this.stateCache.get(hash);
      if (!bucket) {
        bucket = [];
        this.stateCache.set(hash, bucket);
      }
      bucket.push(state);
      this.stateCount++;
    }
    if (this.startState && !survivors.has(this.startState)) this.startState = null;
  }
  step(state, charCode, anchor) {
    if (charCode <= Unicode.MAX_LATIN1) if (anchor === RE2Flags.UNANCHORED) {
      const next = state.nextLatin1[charCode];
      if (next !== null) return next;
    } else {
      const next = state.nextLatin1Anchored[charCode];
      if (next !== null) return next;
    }
    else {
      const key = charCode + (anchor === RE2Flags.UNANCHORED ? 0 : Unicode.MAX_RUNE + 1);
      const keys = state.transKeys;
      const len = keys.length;
      for (let i = 0; i < len; i++) if (keys[i] === key) return state.transVals[i];
    }
    const nextPCs = [];
    for (let i = 0; i < state.nfaStates.length; i++) {
      const pc = state.nfaStates[i];
      const inst = this.prog.getInst(pc);
      if (Inst.isRuneOp(inst.op) && inst.matchRune(charCode)) nextPCs.push(inst.out);
    }
    if (anchor === RE2Flags.UNANCHORED) nextPCs.push(this.prog.start);
    const nextState = this.getState(nextPCs);
    if (charCode <= Unicode.MAX_LATIN1) if (anchor === RE2Flags.UNANCHORED) state.nextLatin1[charCode] = nextState;
    else state.nextLatin1Anchored[charCode] = nextState;
    else {
      const key = charCode + (anchor === RE2Flags.UNANCHORED ? 0 : Unicode.MAX_RUNE + 1);
      state.transKeys.push(key);
      state.transVals.push(nextState);
    }
    return nextState;
  }
  match(input, pos, anchor) {
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return false;
    if (!this.startState) {
      this.startState = this.getState([this.prog.start]);
      if (!this.startState) return null;
    }
    let endPos = input.endPos();
    let currentState = this.startState;
    if (currentState.isMatch) if (anchor === RE2Flags.ANCHOR_BOTH) {
      if (pos === endPos) return true;
    } else return true;
    let i = pos;
    while (i < endPos) {
      const r = input.step(i);
      const rune = r >> 3;
      const width = r & 7;
      if (width === 0) break;
      currentState = anchor === RE2Flags.UNANCHORED && rune <= Unicode.MAX_LATIN1 && currentState.nextLatin1[rune] || this.step(currentState, rune, anchor);
      if (currentState === null) return null;
      currentState.lastSeen = ++this.clock;
      if (currentState.isMatch) if (anchor === RE2Flags.ANCHOR_BOTH) {
        if (i + width === endPos) return true;
      } else return true;
      if (currentState.nfaStates.length === 0) {
        if (anchor !== RE2Flags.UNANCHORED) return false;
      }
      i += width;
    }
    return false;
  }
  matchSet(input, pos, anchor) {
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return [];
    if (!this.startState) {
      this.startState = this.getState([this.prog.start]);
      if (!this.startState) return null;
    }
    let endPos = input.endPos();
    let currentState = this.startState;
    const matches = /* @__PURE__ */ new Set();
    const checkMatch = (state, currentPos) => {
      if (state.isMatch) if (anchor === RE2Flags.ANCHOR_BOTH) {
        if (currentPos === endPos) state.matchIDs.forEach((id) => matches.add(id));
      } else state.matchIDs.forEach((id) => matches.add(id));
    };
    checkMatch(currentState, pos);
    let i = pos;
    while (i < endPos) {
      const r = input.step(i);
      const rune = r >> 3;
      const width = r & 7;
      if (width === 0) break;
      currentState = anchor === RE2Flags.UNANCHORED && rune <= Unicode.MAX_LATIN1 && currentState.nextLatin1[rune] || this.step(currentState, rune, anchor);
      if (currentState === null) return null;
      currentState.lastSeen = ++this.clock;
      i += width;
      checkMatch(currentState, i);
      if (currentState.nfaStates.length === 0) {
        if (anchor !== RE2Flags.UNANCHORED) break;
      }
    }
    return Array.from(matches).sort((a, b) => a - b);
  }
};
var VISITED_BITS = 32;
var MAX_BACKTRACK_PROG = 500;
var INITIAL_JOB_CAPACITY = 256;
var MAX_BACKTRACK_VECTOR = 256 * 1024;
var BitState = class {
  constructor() {
    this.end = 0;
    this.cap = /* @__PURE__ */ new Int32Array(0);
    this.matchcap = /* @__PURE__ */ new Int32Array(0);
    this.ncap = 0;
    this.jobPc = new Int32Array(INITIAL_JOB_CAPACITY);
    this.jobArg = new Uint8Array(INITIAL_JOB_CAPACITY);
    this.jobPos = new Int32Array(INITIAL_JOB_CAPACITY);
    this.jobLen = 0;
    this.visited = /* @__PURE__ */ new Uint32Array(0);
  }
  reset(prog, end, ncap) {
    this.end = end;
    this.jobLen = 0;
    this.ncap = ncap;
    const visitedSize = prog.numInst() * (end + 1) + VISITED_BITS - 1 >>> 5;
    if (this.visited.length < visitedSize) this.visited = new Uint32Array(visitedSize);
    else this.visited.fill(0, 0, visitedSize);
    if (this.cap.length < ncap) this.cap = new Int32Array(ncap).fill(-1);
    else this.cap.fill(-1, 0, ncap);
    if (this.matchcap.length < ncap) this.matchcap = new Int32Array(ncap).fill(-1);
    else this.matchcap.fill(-1, 0, ncap);
  }
  shouldVisit(pc, pos) {
    const n = pc * (this.end + 1) + pos;
    const idx = n >>> 5;
    const mask = 1 << (n & 31);
    if ((this.visited[idx] & mask) !== 0) return false;
    this.visited[idx] |= mask;
    return true;
  }
  push(re2, pc, pos, arg) {
    if (re2.prog.getInst(pc).op !== Inst.FAIL && (arg || this.shouldVisit(pc, pos))) {
      if (this.jobLen >= this.jobPc.length) {
        const newSize = this.jobPc.length * 2;
        const newPc = new Int32Array(newSize);
        newPc.set(this.jobPc);
        this.jobPc = newPc;
        const newArg = new Uint8Array(newSize);
        newArg.set(this.jobArg);
        this.jobArg = newArg;
        const newPos = new Int32Array(newSize);
        newPos.set(this.jobPos);
        this.jobPos = newPos;
      }
      this.jobPc[this.jobLen] = pc;
      this.jobArg[this.jobLen] = arg ? 1 : 0;
      this.jobPos[this.jobLen] = pos;
      this.jobLen++;
    }
  }
  tryBacktrack(re2, input, pc, pos, anchor) {
    const longest = re2.longest;
    this.push(re2, pc, pos, false);
    while (this.jobLen > 0) {
      this.jobLen--;
      let currentPc = this.jobPc[this.jobLen];
      let arg = this.jobArg[this.jobLen] === 1;
      let currentPos = this.jobPos[this.jobLen];
      let skipShouldVisit = true;
      while (true) {
        if (!skipShouldVisit) {
          if (!this.shouldVisit(currentPc, currentPos)) break;
        }
        skipShouldVisit = false;
        const inst = re2.prog.getInst(currentPc);
        switch (inst.op) {
          case Inst.FAIL:
            throw new RE2JSInternalException("unexpected InstFail");
          case Inst.ALT:
            if (arg) {
              arg = false;
              currentPc = inst.arg;
              continue;
            } else {
              this.push(re2, currentPc, currentPos, true);
              currentPc = inst.out;
              continue;
            }
          case Inst.ALT_MATCH: {
            const outInst = re2.prog.getInst(inst.out);
            if (Inst.isRuneOp(outInst.op)) {
              this.push(re2, inst.arg, currentPos, false);
              currentPc = inst.arg;
              currentPos = this.end;
              continue;
            }
            this.push(re2, inst.out, this.end, false);
            currentPc = inst.out;
            continue;
          }
          case Inst.RUNE: {
            const r = input.step(currentPos);
            if (r === MachineInputBase.EOF()) break;
            if (!inst.matchRune(r >> 3)) break;
            currentPos += r & 7;
            currentPc = inst.out;
            continue;
          }
          case Inst.RUNE1: {
            const r = input.step(currentPos);
            if (r === MachineInputBase.EOF()) break;
            if (r >> 3 !== inst.runes[0]) break;
            currentPos += r & 7;
            currentPc = inst.out;
            continue;
          }
          case Inst.RUNE_ANY_NOT_NL: {
            const r = input.step(currentPos);
            if (r === MachineInputBase.EOF()) break;
            if (r >> 3 === 10) break;
            currentPos += r & 7;
            currentPc = inst.out;
            continue;
          }
          case Inst.RUNE_ANY: {
            const r = input.step(currentPos);
            if (r === MachineInputBase.EOF()) break;
            currentPos += r & 7;
            currentPc = inst.out;
            continue;
          }
          case Inst.CAPTURE:
            if (arg) {
              this.cap[inst.arg] = currentPos;
              break;
            } else {
              if (inst.arg < this.ncap) {
                this.push(re2, currentPc, this.cap[inst.arg], true);
                this.cap[inst.arg] = currentPos;
              }
              currentPc = inst.out;
              continue;
            }
          case Inst.EMPTY_WIDTH: {
            const flag = input.context(currentPos);
            if ((inst.arg & ~flag) !== 0) break;
            currentPc = inst.out;
            continue;
          }
          case Inst.NOP:
            currentPc = inst.out;
            continue;
          case Inst.MATCH: {
            if (anchor === RE2Flags.ANCHOR_BOTH && currentPos !== this.end) break;
            if (this.ncap === 0) return true;
            if (this.ncap > 1) this.cap[1] = currentPos;
            const old = this.matchcap[1];
            if (old === -1 || longest && currentPos > 0 && currentPos > old) this.matchcap.set(this.cap);
            if (!longest) return true;
            if (currentPos === this.end) return true;
            break;
          }
          case Inst.LB_WRITE:
          case Inst.LB_CHECK:
            throw new RE2JSInternalException("Backtracker cannot evaluate Lookbehind instructions");
          default:
            throw new RE2JSInternalException("bad inst");
        }
        break;
      }
    }
    return longest && this.matchcap.length > 1 && this.matchcap[1] >= 0;
  }
};
var bitStatePool = [];
var Backtracker = class Backtracker2 {
  static shouldBacktrack(prog) {
    return prog.numInst() <= MAX_BACKTRACK_PROG;
  }
  static maxBitStateLen(prog) {
    if (!Backtracker2.shouldBacktrack(prog)) return 0;
    return Math.floor(MAX_BACKTRACK_VECTOR / prog.numInst());
  }
  static execute(re2, input, pos, anchor, ncap) {
    const startCond = re2.cond;
    if (startCond === Utils.EMPTY_ALL) return null;
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return null;
    if ((startCond & Utils.EMPTY_BEGIN_TEXT) !== 0 && pos !== 0) return null;
    const b = bitStatePool.length > 0 ? bitStatePool.pop() : new BitState();
    const end = input.endPos();
    b.reset(re2.prog, end, ncap);
    let matched = false;
    if ((startCond & Utils.EMPTY_BEGIN_TEXT) !== 0 || anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) {
      if (b.ncap > 0) b.cap[0] = pos;
      if (b.tryBacktrack(re2, input, re2.prog.start, pos, anchor)) matched = true;
    } else {
      let width = -1;
      for (; pos <= end && width !== 0; pos += width) {
        if (re2.prefix.length > 0) {
          const advance = input.index(re2, pos);
          if (advance < 0) break;
          pos += advance;
        }
        if (b.ncap > 0) b.cap[0] = pos;
        if (b.tryBacktrack(re2, input, re2.prog.start, pos, anchor)) {
          matched = true;
          break;
        }
        const r = input.step(pos);
        width = r === MachineInputBase.EOF() ? 0 : r & 7;
      }
    }
    if (!matched) {
      bitStatePool.push(b);
      return null;
    }
    const result = ncap === 0 ? [] : Utils.toArray(b.matchcap.subarray(0, ncap));
    bitStatePool.push(b);
    return result;
  }
};
var QueueOnePass = class {
  constructor(size) {
    this.sparse = new Uint32Array(size);
    this.dense = new Uint32Array(size);
    this.size = 0;
    this.nextIndex = 0;
  }
  empty() {
    return this.nextIndex >= this.size;
  }
  next() {
    return this.dense[this.nextIndex++];
  }
  clear() {
    this.size = 0;
    this.nextIndex = 0;
  }
  contains(u) {
    return u < this.sparse.length && this.sparse[u] < this.size && this.dense[this.sparse[u]] === u;
  }
  insert(u) {
    if (!this.contains(u)) this.insertNew(u);
  }
  insertNew(u) {
    if (u >= this.sparse.length) return;
    this.sparse[u] = this.size;
    this.dense[this.size] = u;
    this.size++;
  }
};
var mergeRuneSets = (leftRunes, rightRunes, leftPC, rightPC) => {
  const leftLen = leftRunes.length;
  const rightLen = rightRunes.length;
  let lx = 0, rx = 0;
  const merged = [];
  const next = [];
  let ok = true;
  let ix = -1;
  const extend = (isLeft) => {
    const newArray = isLeft ? leftRunes : rightRunes;
    const low = isLeft ? lx : rx;
    const pc = isLeft ? leftPC : rightPC;
    if (ix > 0 && newArray[low] <= merged[ix]) return false;
    merged.push(newArray[low], newArray[low + 1]);
    if (isLeft) lx += 2;
    else rx += 2;
    ix += 2;
    next.push(pc);
    return true;
  };
  while (lx < leftLen || rx < rightLen) {
    if (rx >= rightLen) ok = extend(true);
    else if (lx >= leftLen) ok = extend(false);
    else if (rightRunes[rx] < leftRunes[lx]) ok = extend(false);
    else ok = extend(true);
    if (!ok) return null;
  }
  return {
    merged,
    next
  };
};
var OnePassProg = class {
  constructor(prog) {
    this.start = prog.start;
    this.numCap = prog.numCap;
    this.inst = new Array(prog.inst.length);
    for (let i = 0; i < prog.inst.length; i++) {
      const orig = prog.inst[i];
      const inst = new Inst(orig.op);
      inst.out = orig.out;
      inst.arg = orig.arg;
      inst.runes = orig.runes ? orig.runes.slice() : [];
      inst.next = null;
      this.inst[i] = inst;
    }
  }
};
var onePassCopy = (prog) => {
  const p = new OnePassProg(prog);
  for (let pc = 0; pc < p.inst.length; pc++) {
    const inst = p.inst[pc];
    if (inst.op !== Inst.ALT && inst.op !== Inst.ALT_MATCH) continue;
    let pAOther = "out";
    let pAAlt = "arg";
    let instAlt = p.inst[inst[pAAlt]];
    if (instAlt.op !== Inst.ALT && instAlt.op !== Inst.ALT_MATCH) {
      pAOther = "arg";
      pAAlt = "out";
      instAlt = p.inst[inst[pAAlt]];
      if (instAlt.op !== Inst.ALT && instAlt.op !== Inst.ALT_MATCH) continue;
    }
    const instOther = p.inst[inst[pAOther]];
    if (instOther.op === Inst.ALT || instOther.op === Inst.ALT_MATCH) continue;
    let pBAlt = "out";
    let pBOther = "arg";
    let patch = false;
    if (instAlt.out === pc) patch = true;
    else if (instAlt.arg === pc) {
      patch = true;
      pBAlt = "arg";
      pBOther = "out";
    }
    if (patch) instAlt[pBAlt] = inst[pAOther];
    if (inst[pAOther] === instAlt[pBAlt]) inst[pAAlt] = instAlt[pBOther];
  }
  return p;
};
var makeOnePass = (p) => {
  if (p.inst.length >= 1e3) return null;
  const instQueue = new QueueOnePass(p.inst.length);
  const visitQueue = new QueueOnePass(p.inst.length);
  const onePassRunes = new Array(p.inst.length);
  const m = new Array(p.inst.length).fill(false);
  const check = (pc) => {
    let ok = true;
    const inst = p.inst[pc];
    if (visitQueue.contains(pc)) return true;
    visitQueue.insert(pc);
    switch (inst.op) {
      case Inst.ALT:
      case Inst.ALT_MATCH: {
        ok = check(inst.out) && check(inst.arg);
        let matchOut = m[inst.out];
        let matchArg = m[inst.arg];
        if (matchOut && matchArg) return false;
        if (matchArg) {
          const tempOut = inst.out;
          inst.out = inst.arg;
          inst.arg = tempOut;
          const tempMatch = matchOut;
          matchOut = matchArg;
          matchArg = tempMatch;
        }
        if (matchOut) {
          m[pc] = true;
          inst.op = Inst.ALT_MATCH;
        }
        const leftRunes = onePassRunes[inst.out] || [];
        const rightRunes = onePassRunes[inst.arg] || [];
        const mergeRes = mergeRuneSets(leftRunes, rightRunes, inst.out, inst.arg);
        if (!mergeRes) return false;
        onePassRunes[pc] = mergeRes.merged;
        inst.next = new Uint32Array(mergeRes.next);
        break;
      }
      case Inst.CAPTURE:
      case Inst.EMPTY_WIDTH:
      case Inst.NOP:
        ok = check(inst.out);
        m[pc] = m[inst.out];
        onePassRunes[pc] = onePassRunes[inst.out] ? onePassRunes[inst.out].slice() : [];
        inst.next = new Uint32Array(Math.floor(onePassRunes[pc].length / 2) + 1).fill(inst.out);
        break;
      case Inst.MATCH:
      case Inst.FAIL:
        m[pc] = inst.op === Inst.MATCH;
        break;
      case Inst.RUNE: {
        m[pc] = false;
        if (inst.next && inst.next.length > 0) break;
        instQueue.insert(inst.out);
        if (!inst.runes || inst.runes.length === 0) {
          onePassRunes[pc] = [];
          inst.next = new Uint32Array([inst.out]);
          break;
        }
        let runes = [];
        if (inst.runes.length === 1 && (inst.arg & RE2Flags.FOLD_CASE) !== 0) {
          const r0 = inst.runes[0];
          runes.push(r0, r0);
          for (let r1 = Unicode.simpleFold(r0); r1 !== r0; r1 = Unicode.simpleFold(r1)) runes.push(r1, r1);
          runes.sort((a, b) => a - b);
        } else for (let j = 0; j < inst.runes.length; j++) runes.push(inst.runes[j]);
        onePassRunes[pc] = runes;
        inst.next = new Uint32Array(Math.floor(runes.length / 2) + 1).fill(inst.out);
        inst.op = Inst.RUNE;
        break;
      }
      case Inst.RUNE1: {
        m[pc] = false;
        if (inst.next && inst.next.length > 0) break;
        instQueue.insert(inst.out);
        let runes = [];
        if ((inst.arg & RE2Flags.FOLD_CASE) !== 0) {
          const r0 = inst.runes[0];
          runes.push(r0, r0);
          for (let r1 = Unicode.simpleFold(r0); r1 !== r0; r1 = Unicode.simpleFold(r1)) runes.push(r1, r1);
          runes.sort((a, b) => a - b);
        } else runes.push(inst.runes[0], inst.runes[0]);
        onePassRunes[pc] = runes;
        inst.next = new Uint32Array(Math.floor(runes.length / 2) + 1).fill(inst.out);
        inst.op = Inst.RUNE;
        break;
      }
      case Inst.RUNE_ANY:
        m[pc] = false;
        if (inst.next && inst.next.length > 0) break;
        instQueue.insert(inst.out);
        onePassRunes[pc] = [0, Unicode.MAX_RUNE];
        inst.next = new Uint32Array([inst.out]);
        break;
      case Inst.RUNE_ANY_NOT_NL:
        m[pc] = false;
        if (inst.next && inst.next.length > 0) break;
        instQueue.insert(inst.out);
        onePassRunes[pc] = [
          0,
          9,
          11,
          Unicode.MAX_RUNE
        ];
        inst.next = new Uint32Array(Math.floor(onePassRunes[pc].length / 2) + 1).fill(inst.out);
        break;
    }
    return ok;
  };
  instQueue.clear();
  instQueue.insert(p.start);
  while (!instQueue.empty()) {
    visitQueue.clear();
    if (!check(instQueue.next())) return null;
  }
  for (let i = 0; i < p.inst.length; i++) if (onePassRunes[i]) p.inst[i].runes = onePassRunes[i];
  return p;
};
var cleanupOnePass = (p, original) => {
  for (let ix = 0; ix < original.inst.length; ix++) {
    const instOriginal = original.inst[ix];
    switch (instOriginal.op) {
      case Inst.ALT:
      case Inst.ALT_MATCH:
      case Inst.RUNE:
        break;
      case Inst.CAPTURE:
      case Inst.EMPTY_WIDTH:
      case Inst.NOP:
      case Inst.MATCH:
      case Inst.FAIL:
        p.inst[ix].next = null;
        break;
      case Inst.RUNE1:
      case Inst.RUNE_ANY:
      case Inst.RUNE_ANY_NOT_NL:
        p.inst[ix].next = null;
        p.inst[ix].op = instOriginal.op;
        p.inst[ix].runes = instOriginal.runes ? instOriginal.runes.slice() : [];
        break;
    }
  }
};
var OnePass = class OnePass2 {
  static compile(prog) {
    if (prog.start === 0) return null;
    if (prog.numLb > 0) return null;
    const startInst = prog.inst[prog.start];
    if (startInst.op !== Inst.EMPTY_WIDTH || (startInst.arg & Utils.EMPTY_BEGIN_TEXT) === 0) return null;
    let hasAlt = false;
    for (let i = 0; i < prog.inst.length; i++) if (prog.inst[i].op === Inst.ALT || prog.inst[i].op === Inst.ALT_MATCH) {
      hasAlt = true;
      break;
    }
    for (let i = 0; i < prog.inst.length; i++) {
      const inst = prog.inst[i];
      const opOut = prog.inst[inst.out].op;
      switch (inst.op) {
        case Inst.ALT:
        case Inst.ALT_MATCH:
          if (opOut === Inst.MATCH || prog.inst[inst.arg].op === Inst.MATCH) return null;
          break;
        case Inst.EMPTY_WIDTH:
          if (opOut === Inst.MATCH) {
            if ((inst.arg & Utils.EMPTY_END_TEXT) === Utils.EMPTY_END_TEXT) continue;
            return null;
          }
          break;
        default:
          if (opOut === Inst.MATCH && hasAlt) return null;
          break;
      }
    }
    let p = onePassCopy(prog);
    p = makeOnePass(p);
    if (p !== null) cleanupOnePass(p, prog);
    return p;
  }
  static next(inst, r) {
    const nextIdx = inst.matchRunePos(r);
    if (nextIdx >= 0) return inst.next[nextIdx];
    if (inst.op === Inst.ALT_MATCH) return inst.out;
    return 0;
  }
  static execute(re2, input, pos, anchor, ncap) {
    const onepass = re2.onepass;
    if (!onepass) return null;
    const matchcap = new Int32Array(ncap).fill(-1);
    let matched = false;
    let r = input.step(pos);
    let rune = r >> 3;
    let width = r & 7;
    let r1 = MachineInputBase.EOF();
    let rune1 = -1;
    let width1 = 0;
    if (r !== MachineInputBase.EOF()) {
      r1 = input.step(pos + width);
      if (r1 !== MachineInputBase.EOF()) {
        rune1 = r1 >> 3;
        width1 = r1 & 7;
      }
    }
    let flag = pos === 0 ? Utils.emptyOpContext(-1, rune) : input.context(pos);
    let pc = onepass.start;
    let inst;
    while (true) {
      inst = onepass.inst[pc];
      pc = inst.out;
      switch (inst.op) {
        case Inst.MATCH:
          if (anchor === RE2Flags.ANCHOR_BOTH && pos !== input.endPos()) return null;
          matched = true;
          if (matchcap.length > 0) {
            matchcap[0] = 0;
            matchcap[1] = pos;
          }
          return ncap === 0 ? [] : Utils.toArray(matchcap);
        case Inst.RUNE:
          if (!inst.matchRune(rune)) return null;
          break;
        case Inst.RUNE1:
          if (rune !== inst.runes[0]) return null;
          break;
        case Inst.RUNE_ANY:
          break;
        case Inst.RUNE_ANY_NOT_NL:
          if (rune === 10) return null;
          break;
        case Inst.ALT:
        case Inst.ALT_MATCH:
          pc = OnePass2.next(inst, rune);
          continue;
        case Inst.FAIL:
          return null;
        case Inst.NOP:
          continue;
        case Inst.EMPTY_WIDTH:
          if ((inst.arg & ~flag) !== 0) return null;
          continue;
        case Inst.CAPTURE:
          if (inst.arg < matchcap.length) matchcap[inst.arg] = pos;
          continue;
        default:
          throw new RE2JSInternalException("bad inst");
      }
      if (width === 0) break;
      flag = Utils.emptyOpContext(rune, rune1);
      pos += width;
      rune = rune1;
      width = width1;
      if (rune !== -1) {
        r1 = input.step(pos + width);
        if (r1 !== MachineInputBase.EOF()) {
          rune1 = r1 >> 3;
          width1 = r1 & 7;
        } else {
          rune1 = -1;
          width1 = 0;
        }
      }
    }
    if (!matched) return null;
    return ncap === 0 ? [] : Utils.toArray(matchcap);
  }
};
var Regexp = class Regexp2 {
  static Op = createEnum([
    "NO_MATCH",
    "EMPTY_MATCH",
    "LITERAL",
    "CHAR_CLASS",
    "ANY_CHAR_NOT_NL",
    "ANY_CHAR",
    "BEGIN_LINE",
    "END_LINE",
    "BEGIN_TEXT",
    "END_TEXT",
    "WORD_BOUNDARY",
    "NO_WORD_BOUNDARY",
    "CAPTURE",
    "STAR",
    "PLUS",
    "QUEST",
    "REPEAT",
    "CONCAT",
    "ALTERNATE",
    "PLB",
    "NLB",
    "LEFT_PAREN",
    "VERTICAL_BAR"
  ]);
  static isPseudoOp(op) {
    return op >= Regexp2.Op.LEFT_PAREN;
  }
  static emptySubs() {
    return [];
  }
  static quoteIfHyphen(rune) {
    if (rune === Codepoint.CODES.get("-")) return "\\";
    return "";
  }
  static fromRegexp(re) {
    const regex = new Regexp2(re.op);
    regex.flags = re.flags;
    regex.subs = re.subs;
    regex.runes = re.runes;
    regex.cap = re.cap;
    regex.min = re.min;
    regex.max = re.max;
    regex.name = re.name;
    regex.namedGroups = re.namedGroups;
    regex.lb = re.lb;
    return regex;
  }
  constructor(op) {
    this.op = op;
    this.flags = 0;
    this.subs = Regexp2.emptySubs();
    this.runes = [];
    this.min = 0;
    this.max = 0;
    this.cap = 0;
    this.name = null;
    this.namedGroups = /* @__PURE__ */ Object.create(null);
    this.lb = 0;
  }
  reinit() {
    this.flags = 0;
    this.subs = Regexp2.emptySubs();
    this.runes = [];
    this.cap = 0;
    this.min = 0;
    this.max = 0;
    this.name = null;
    this.namedGroups = /* @__PURE__ */ Object.create(null);
    this.lb = 0;
  }
  toString() {
    return this.appendTo();
  }
  appendTo() {
    let out = "";
    switch (this.op) {
      case Regexp2.Op.NO_MATCH:
        out += "[^\\x00-\\x{10FFFF}]";
        break;
      case Regexp2.Op.EMPTY_MATCH:
        out += "(?:)";
        break;
      case Regexp2.Op.STAR:
      case Regexp2.Op.PLUS:
      case Regexp2.Op.QUEST:
      case Regexp2.Op.REPEAT: {
        const sub = this.subs[0];
        if (sub.op > Regexp2.Op.CAPTURE || sub.op === Regexp2.Op.LITERAL && sub.runes.length > 1) out += `(?:${sub.appendTo()})`;
        else out += sub.appendTo();
        switch (this.op) {
          case Regexp2.Op.STAR:
            out += "*";
            break;
          case Regexp2.Op.PLUS:
            out += "+";
            break;
          case Regexp2.Op.QUEST:
            out += "?";
            break;
          case Regexp2.Op.REPEAT:
            out += `{${this.min}`;
            if (this.min !== this.max) {
              out += ",";
              if (this.max >= 0) out += this.max;
            }
            out += "}";
            break;
        }
        if ((this.flags & RE2Flags.NON_GREEDY) !== 0) out += "?";
        break;
      }
      case Regexp2.Op.CONCAT:
        for (let sub of this.subs) if (sub.op === Regexp2.Op.ALTERNATE) out += `(?:${sub.appendTo()})`;
        else out += sub.appendTo();
        break;
      case Regexp2.Op.ALTERNATE: {
        let sep2 = "";
        for (let sub of this.subs) {
          out += sep2;
          sep2 = "|";
          out += sub.appendTo();
        }
        break;
      }
      case Regexp2.Op.LITERAL:
        if ((this.flags & RE2Flags.FOLD_CASE) !== 0) out += "(?i:";
        for (let rune of this.runes) out += Utils.escapeRune(rune);
        if ((this.flags & RE2Flags.FOLD_CASE) !== 0) out += ")";
        break;
      case Regexp2.Op.ANY_CHAR_NOT_NL:
        out += "(?-s:.)";
        break;
      case Regexp2.Op.ANY_CHAR:
        out += "(?s:.)";
        break;
      case Regexp2.Op.PLB:
        out += `(?<=${this.subs[0].appendTo()})`;
        break;
      case Regexp2.Op.NLB:
        out += `(?<!${this.subs[0].appendTo()})`;
        break;
      case Regexp2.Op.CAPTURE:
        if (this.name === null || this.name.length === 0) out += "(";
        else out += `(?P<${this.name}>`;
        if (this.subs[0].op !== Regexp2.Op.EMPTY_MATCH) out += this.subs[0].appendTo();
        out += ")";
        break;
      case Regexp2.Op.BEGIN_TEXT:
        out += "\\A";
        break;
      case Regexp2.Op.END_TEXT:
        if ((this.flags & RE2Flags.WAS_DOLLAR) !== 0) out += "(?-m:$)";
        else out += "\\z";
        break;
      case Regexp2.Op.BEGIN_LINE:
        out += "^";
        break;
      case Regexp2.Op.END_LINE:
        out += "$";
        break;
      case Regexp2.Op.WORD_BOUNDARY:
        out += "\\b";
        break;
      case Regexp2.Op.NO_WORD_BOUNDARY:
        out += "\\B";
        break;
      case Regexp2.Op.CHAR_CLASS:
        if (this.runes.length % 2 !== 0) {
          out += "[invalid char class]";
          break;
        }
        out += "[";
        if (this.runes.length === 0) out += "^\\x00-\\x{10FFFF}";
        else if (this.runes[0] === 0 && this.runes[this.runes.length - 1] === Unicode.MAX_RUNE) {
          out += "^";
          for (let i = 1; i < this.runes.length - 1; i += 2) {
            const lo = this.runes[i] + 1;
            const hi = this.runes[i + 1] - 1;
            out += Regexp2.quoteIfHyphen(lo);
            out += Utils.escapeRune(lo);
            if (lo !== hi) {
              out += "-";
              out += Regexp2.quoteIfHyphen(hi);
              out += Utils.escapeRune(hi);
            }
          }
        } else for (let i = 0; i < this.runes.length; i += 2) {
          const lo = this.runes[i];
          const hi = this.runes[i + 1];
          out += Regexp2.quoteIfHyphen(lo);
          out += Utils.escapeRune(lo);
          if (lo !== hi) {
            out += "-";
            out += Regexp2.quoteIfHyphen(hi);
            out += Utils.escapeRune(hi);
          }
        }
        out += "]";
        break;
      default:
        out += this.op;
        break;
    }
    return out;
  }
  maxCap() {
    let m = 0;
    if (this.op === Regexp2.Op.CAPTURE) m = this.cap;
    if (this.subs !== null) for (let sub of this.subs) {
      const n = sub.maxCap();
      if (m < n) m = n;
    }
    return m;
  }
  equals(that) {
    if (!(that !== null && that instanceof Regexp2)) return false;
    if (this.op !== that.op) return false;
    switch (this.op) {
      case Regexp2.Op.END_TEXT:
        if ((this.flags & RE2Flags.WAS_DOLLAR) !== (that.flags & RE2Flags.WAS_DOLLAR)) return false;
        break;
      case Regexp2.Op.LITERAL:
      case Regexp2.Op.CHAR_CLASS:
        if (this.runes === null && that.runes === null) break;
        if (this.runes === null || that.runes === null) return false;
        if (this.runes.length !== that.runes.length) return false;
        for (let i = 0; i < this.runes.length; i++) if (this.runes[i] !== that.runes[i]) return false;
        break;
      case Regexp2.Op.ALTERNATE:
      case Regexp2.Op.CONCAT:
        if (this.subs.length !== that.subs.length) return false;
        for (let i = 0; i < this.subs.length; ++i) if (!this.subs[i].equals(that.subs[i])) return false;
        break;
      case Regexp2.Op.STAR:
      case Regexp2.Op.PLUS:
      case Regexp2.Op.QUEST:
        if ((this.flags & RE2Flags.NON_GREEDY) !== (that.flags & RE2Flags.NON_GREEDY) || !this.subs[0].equals(that.subs[0])) return false;
        break;
      case Regexp2.Op.REPEAT:
        if ((this.flags & RE2Flags.NON_GREEDY) !== (that.flags & RE2Flags.NON_GREEDY) || this.min !== that.min || this.max !== that.max || !this.subs[0].equals(that.subs[0])) return false;
        break;
      case Regexp2.Op.CAPTURE:
        if (this.cap !== that.cap || (this.name === null ? that.name !== null : this.name !== that.name) || !this.subs[0].equals(that.subs[0])) return false;
        break;
      case Regexp2.Op.PLB:
      case Regexp2.Op.NLB:
        if (this.lb !== that.lb || !this.subs[0].equals(that.subs[0])) return false;
        break;
    }
    return true;
  }
};
var AhoCorasick = class {
  constructor(wordArrays) {
    this.next = [/* @__PURE__ */ Object.create(null)];
    this.fail = [0];
    this.match = [false];
    for (const word of wordArrays) {
      let node = 0;
      for (let i = 0; i < word.length; i++) {
        const val = word[i];
        if (!(val in this.next[node])) {
          this.next.push(/* @__PURE__ */ Object.create(null));
          this.fail.push(0);
          this.match.push(false);
          this.next[node][val] = this.next.length - 1;
        }
        node = this.next[node][val];
      }
      this.match[node] = true;
    }
    const queue = [];
    for (const val in this.next[0]) if (Object.prototype.hasOwnProperty.call(this.next[0], val)) {
      const child = this.next[0][val];
      this.fail[child] = 0;
      queue.push(child);
    }
    while (queue.length > 0) {
      const curr = queue.shift();
      for (const val in this.next[curr]) if (Object.prototype.hasOwnProperty.call(this.next[curr], val)) {
        const child = this.next[curr][val];
        let failNode = this.fail[curr];
        while (failNode !== 0 && !(val in this.next[failNode])) failNode = this.fail[failNode];
        if (val in this.next[failNode]) this.fail[child] = this.next[failNode][val];
        else this.fail[child] = 0;
        this.match[child] = this.match[child] || this.match[this.fail[child]];
        queue.push(child);
      }
    }
  }
  searchUTF16(charSeq, start, end) {
    let node = 0;
    for (let i = start; i < end; i++) {
      const val = charSeq.charCodeAt(i);
      while (node !== 0 && !(val in this.next[node])) node = this.fail[node];
      if (val in this.next[node]) node = this.next[node][val];
      if (this.match[node]) return true;
    }
    return false;
  }
  searchUTF8(bytes, start, end) {
    let node = 0;
    for (let i = start; i < end; i++) {
      const val = bytes[i];
      while (node !== 0 && !(val in this.next[node])) node = this.fail[node];
      if (val in this.next[node]) node = this.next[node][val];
      if (this.match[node]) return true;
    }
    return false;
  }
};
var Prefilter = class Prefilter2 {
  static Type = {
    NONE: 0,
    EXACT: 1,
    AND: 2,
    OR: 3
  };
  constructor(type) {
    this.type = type;
    this.subs = [];
    this.str = "";
    this.bytes = null;
    this.ac16 = null;
    this.ac8 = null;
  }
  eval(input, pos) {
    switch (this.type) {
      case Prefilter2.Type.NONE:
        return true;
      case Prefilter2.Type.EXACT:
        return input.hasString(this, pos);
      case Prefilter2.Type.AND:
        for (let i = 0; i < this.subs.length; i++) if (!this.subs[i].eval(input, pos)) return false;
        return true;
      case Prefilter2.Type.OR:
        if (this.ac16 && this.ac8) return input.hasAnyString(this, pos);
        for (let i = 0; i < this.subs.length; i++) if (this.subs[i].eval(input, pos)) return true;
        return false;
      default:
        return true;
    }
  }
};
var PrefilterTree = class PrefilterTree2 {
  static build(re) {
    const pf = PrefilterTree2.fromRegexp(re);
    return PrefilterTree2.simplify(pf);
  }
  static fromRegexp(re) {
    if (!re) return new Prefilter(Prefilter.Type.NONE);
    switch (re.op) {
      case Regexp.Op.PLB:
      case Regexp.Op.NLB:
      case Regexp.Op.NO_MATCH:
      case Regexp.Op.EMPTY_MATCH:
      case Regexp.Op.BEGIN_LINE:
      case Regexp.Op.END_LINE:
      case Regexp.Op.BEGIN_TEXT:
      case Regexp.Op.END_TEXT:
      case Regexp.Op.WORD_BOUNDARY:
      case Regexp.Op.NO_WORD_BOUNDARY:
      case Regexp.Op.CHAR_CLASS:
      case Regexp.Op.ANY_CHAR_NOT_NL:
      case Regexp.Op.ANY_CHAR:
        return new Prefilter(Prefilter.Type.NONE);
      case Regexp.Op.LITERAL: {
        if (re.runes.length === 0 || (re.flags & RE2Flags.FOLD_CASE) !== 0) return new Prefilter(Prefilter.Type.NONE);
        const pf = new Prefilter(Prefilter.Type.EXACT);
        let str = "";
        for (let i = 0; i < re.runes.length; i++) str += String.fromCodePoint(re.runes[i]);
        pf.str = str;
        pf.bytes = Utils.stringToUtf8ByteArray(pf.str);
        return pf;
      }
      case Regexp.Op.CAPTURE:
      case Regexp.Op.PLUS:
        return PrefilterTree2.fromRegexp(re.subs[0]);
      case Regexp.Op.REPEAT:
        if (re.min >= 1) return PrefilterTree2.fromRegexp(re.subs[0]);
        return new Prefilter(Prefilter.Type.NONE);
      case Regexp.Op.CONCAT: {
        const pf = new Prefilter(Prefilter.Type.AND);
        for (const sub of re.subs) pf.subs.push(PrefilterTree2.fromRegexp(sub));
        return pf;
      }
      case Regexp.Op.ALTERNATE: {
        const pf = new Prefilter(Prefilter.Type.OR);
        for (const sub of re.subs) pf.subs.push(PrefilterTree2.fromRegexp(sub));
        return pf;
      }
      default:
        return new Prefilter(Prefilter.Type.NONE);
    }
  }
  static simplify(pf) {
    if (pf.type === Prefilter.Type.EXACT || pf.type === Prefilter.Type.NONE) return pf;
    if (pf.type === Prefilter.Type.AND) {
      const newSubs = [];
      for (const sub of pf.subs) {
        const s = PrefilterTree2.simplify(sub);
        if (s.type !== Prefilter.Type.NONE) if (s.type === Prefilter.Type.AND) for (let j = 0; j < s.subs.length; j++) newSubs.push(s.subs[j]);
        else newSubs.push(s);
      }
      if (newSubs.length === 0) return new Prefilter(Prefilter.Type.NONE);
      if (newSubs.length === 1) return newSubs[0];
      pf.subs = newSubs;
      return pf;
    }
    if (pf.type === Prefilter.Type.OR) {
      const newSubs = [];
      for (const sub of pf.subs) {
        const s = PrefilterTree2.simplify(sub);
        if (s.type === Prefilter.Type.NONE) return new Prefilter(Prefilter.Type.NONE);
        if (s.type === Prefilter.Type.OR) for (let j = 0; j < s.subs.length; j++) newSubs.push(s.subs[j]);
        else newSubs.push(s);
      }
      if (newSubs.length === 0) return new Prefilter(Prefilter.Type.NONE);
      if (newSubs.length === 1) return newSubs[0];
      const seen = /* @__PURE__ */ new Set();
      const uniqueSubs = [];
      for (const sub of newSubs) if (sub.type === Prefilter.Type.EXACT) {
        if (!seen.has(sub.str)) {
          seen.add(sub.str);
          uniqueSubs.push(sub);
        }
      } else uniqueSubs.push(sub);
      pf.subs = uniqueSubs;
      let allExact = true;
      for (const sub of uniqueSubs) if (sub.type !== Prefilter.Type.EXACT) {
        allExact = false;
        break;
      }
      if (allExact && uniqueSubs.length > 1) {
        pf.ac16 = new AhoCorasick(uniqueSubs.map((s) => {
          const arr = [];
          for (let i = 0; i < s.str.length; i++) arr.push(s.str.charCodeAt(i));
          return arr;
        }));
        pf.ac8 = new AhoCorasick(uniqueSubs.map((s) => s.bytes));
      }
      return pf;
    }
    return pf;
  }
};
var PatchList = class {
  /**
  * @param {number} head - Encoded pointer to the start of the patch list.
  * @param {number} tail - Encoded pointer to the end of the patch list.
  */
  constructor(head = 0, tail = 0) {
    this.head = head;
    this.tail = tail;
  }
};
var Prog = class {
  constructor() {
    this.inst = [];
    this.start = 0;
    this.numCap = 2;
    this.lbStarts = [];
    this.numLb = 0;
  }
  getInst(pc) {
    return this.inst[pc];
  }
  numInst() {
    return this.inst.length;
  }
  addInst(op) {
    this.inst.push(new Inst(op));
  }
  skipNop(pc) {
    let i = this.inst[pc];
    while (i.op === Inst.NOP || i.op === Inst.CAPTURE) {
      i = this.inst[pc];
      pc = i.out;
    }
    return i;
  }
  prefix() {
    let prefix = "";
    let i = this.skipNop(this.start);
    if (!Inst.isRuneOp(i.op) || i.runes.length !== 1) return [i.op === Inst.MATCH, prefix];
    while (Inst.isRuneOp(i.op) && i.runes.length === 1 && (i.arg & RE2Flags.FOLD_CASE) === 0) {
      prefix += String.fromCodePoint(i.runes[0]);
      i = this.skipNop(i.out);
    }
    return [i.op === Inst.MATCH, prefix];
  }
  startCond() {
    let flag = 0;
    let pc = this.start;
    loop: for (; ; ) {
      const i = this.inst[pc];
      switch (i.op) {
        case Inst.EMPTY_WIDTH:
          flag |= i.arg;
          break;
        case Inst.FAIL:
          return -1;
        case Inst.CAPTURE:
        case Inst.NOP:
          break;
        default:
          break loop;
      }
      pc = i.out;
    }
    return flag;
  }
  patch(l, val) {
    let head = l.head;
    while (head !== 0) {
      const i = this.inst[head >> 1];
      if ((head & 1) === 0) {
        head = i.out;
        i.out = val;
      } else {
        head = i.arg;
        i.arg = val;
      }
    }
  }
  append(l1, l2) {
    if (l1.head === 0) return l2;
    if (l2.head === 0) return l1;
    const i = this.inst[l1.tail >> 1];
    if ((l1.tail & 1) === 0) i.out = l2.head;
    else i.arg = l2.head;
    return new PatchList(l1.head, l2.tail);
  }
  /**
  *
  * @returns {string}
  */
  toString() {
    let out = "";
    for (let pc = 0; pc < this.inst.length; pc++) {
      const len = out.length;
      out += pc;
      if (pc === this.start) out += "*";
      out += "        ".substring(out.length - len);
      out += this.inst[pc];
      out += "\n";
    }
    return out;
  }
};
var Frag = class {
  constructor(i = 0, out = new PatchList(), nullable = false) {
    this.i = i;
    this.out = out;
    this.nullable = nullable;
  }
};
var Compiler = class Compiler2 {
  static ANY_RUNE_NOT_NL() {
    return [
      0,
      Codepoint.CODES.get("\n") - 1,
      Codepoint.CODES.get("\n") + 1,
      Unicode.MAX_RUNE
    ];
  }
  static ANY_RUNE() {
    return [0, Unicode.MAX_RUNE];
  }
  static compileRegexp(re) {
    const c = new Compiler2();
    const f = c.compile(re);
    c.prog.patch(f.out, c.newInst(Inst.MATCH).i);
    c.prog.start = f.i;
    return c.prog;
  }
  static compileSet(regexps) {
    const c = new Compiler2();
    if (regexps.length === 0) {
      c.prog.start = c.newInst(Inst.FAIL).i;
      return c.prog;
    }
    let starts = [];
    for (let i = 0; i < regexps.length; i++) {
      const f = c.compile(regexps[i]);
      const m = c.newInst(Inst.MATCH);
      c.prog.getInst(m.i).arg = i;
      c.prog.patch(f.out, m.i);
      starts.push(f.i);
    }
    let start = starts[0];
    for (let i = 1; i < starts.length; i++) {
      const f = c.newInst(Inst.ALT);
      const inst = c.prog.getInst(f.i);
      inst.out = start;
      inst.arg = starts[i];
      start = f.i;
    }
    c.prog.start = start;
    return c.prog;
  }
  constructor() {
    this.prog = new Prog();
    this.newInst(Inst.FAIL);
  }
  newInst(op) {
    this.prog.addInst(op);
    return new Frag(this.prog.numInst() - 1, new PatchList(), true);
  }
  nop() {
    const f = this.newInst(Inst.NOP);
    f.out = new PatchList(f.i << 1, f.i << 1);
    return f;
  }
  fail() {
    return new Frag();
  }
  cap(arg) {
    const f = this.newInst(Inst.CAPTURE);
    f.out = new PatchList(f.i << 1, f.i << 1);
    this.prog.getInst(f.i).arg = arg;
    if (this.prog.numCap < arg + 1) this.prog.numCap = arg + 1;
    return f;
  }
  cat(f1, f2) {
    if (f1.i === 0 || f2.i === 0) return this.fail();
    this.prog.patch(f1.out, f2.i);
    return new Frag(f1.i, f2.out, f1.nullable && f2.nullable);
  }
  alt(f1, f2) {
    if (f1.i === 0) return f2;
    if (f2.i === 0) return f1;
    const f = this.newInst(Inst.ALT);
    const i = this.prog.getInst(f.i);
    i.out = f1.i;
    i.arg = f2.i;
    f.out = this.prog.append(f1.out, f2.out);
    f.nullable = f1.nullable || f2.nullable;
    return f;
  }
  loop(f1, nongreedy) {
    const f = this.newInst(Inst.ALT);
    const i = this.prog.getInst(f.i);
    if (nongreedy) {
      i.arg = f1.i;
      f.out = new PatchList(f.i << 1, f.i << 1);
    } else {
      i.out = f1.i;
      f.out = new PatchList(f.i << 1 | 1, f.i << 1 | 1);
    }
    this.prog.patch(f1.out, f.i);
    return f;
  }
  quest(f1, nongreedy) {
    const f = this.newInst(Inst.ALT);
    const i = this.prog.getInst(f.i);
    if (nongreedy) {
      i.arg = f1.i;
      f.out = new PatchList(f.i << 1, f.i << 1);
    } else {
      i.out = f1.i;
      f.out = new PatchList(f.i << 1 | 1, f.i << 1 | 1);
    }
    f.out = this.prog.append(f.out, f1.out);
    return f;
  }
  star(f1, nongreedy) {
    if (f1.nullable) return this.quest(this.plus(f1, nongreedy), nongreedy);
    return this.loop(f1, nongreedy);
  }
  plus(f1, nongreedy) {
    return new Frag(f1.i, this.loop(f1, nongreedy).out, f1.nullable);
  }
  empty(op) {
    const f = this.newInst(Inst.EMPTY_WIDTH);
    this.prog.getInst(f.i).arg = op;
    f.out = new PatchList(f.i << 1, f.i << 1);
    return f;
  }
  rune(runes, flags) {
    const f = this.newInst(Inst.RUNE);
    f.nullable = false;
    const i = this.prog.getInst(f.i);
    i.runes = runes;
    flags &= RE2Flags.FOLD_CASE;
    if (runes.length !== 1 || Unicode.simpleFold(runes[0]) === runes[0]) flags &= ~RE2Flags.FOLD_CASE;
    i.arg = flags;
    f.out = new PatchList(f.i << 1, f.i << 1);
    if ((flags & RE2Flags.FOLD_CASE) === 0 && runes.length === 1 || runes.length === 2 && runes[0] === runes[1]) i.op = Inst.RUNE1;
    else if (runes.length === 2 && runes[0] === 0 && runes[1] === Unicode.MAX_RUNE) i.op = Inst.RUNE_ANY;
    else if (runes.length === 4 && runes[0] === 0 && runes[1] === Codepoint.CODES.get("\n") - 1 && runes[2] === Codepoint.CODES.get("\n") + 1 && runes[3] === Unicode.MAX_RUNE) i.op = Inst.RUNE_ANY_NOT_NL;
    return f;
  }
  lookBehind(a, lb) {
    const id = this.newInst(Inst.LB_WRITE);
    this.prog.getInst(id.i).arg = lb;
    const any = this.rune(Compiler2.ANY_RUNE(), 0);
    const dotStar = this.star(any, true);
    const lbAutomaton = this.cat(dotStar, a);
    this.prog.patch(lbAutomaton.out, id.i);
    const checkId = this.newInst(Inst.LB_CHECK);
    this.prog.getInst(checkId.i).arg = lb;
    this.prog.lbStarts.push(lbAutomaton.i);
    if (Math.abs(lb) > this.prog.numLb) this.prog.numLb = Math.abs(lb);
    checkId.out = new PatchList(checkId.i << 1, checkId.i << 1);
    return checkId;
  }
  compile(re) {
    switch (re.op) {
      case Regexp.Op.NO_MATCH:
        return this.fail();
      case Regexp.Op.EMPTY_MATCH:
        return this.nop();
      case Regexp.Op.LITERAL:
        if (re.runes.length === 0) return this.nop();
        else {
          let f = null;
          for (let r of re.runes) {
            const f1 = this.rune([r], re.flags);
            f = f === null ? f1 : this.cat(f, f1);
          }
          return f;
        }
      case Regexp.Op.CHAR_CLASS:
        return this.rune(re.runes, re.flags);
      case Regexp.Op.ANY_CHAR_NOT_NL:
        return this.rune(Compiler2.ANY_RUNE_NOT_NL(), 0);
      case Regexp.Op.ANY_CHAR:
        return this.rune(Compiler2.ANY_RUNE(), 0);
      case Regexp.Op.BEGIN_LINE:
        return this.empty(Utils.EMPTY_BEGIN_LINE);
      case Regexp.Op.END_LINE:
        return this.empty(Utils.EMPTY_END_LINE);
      case Regexp.Op.BEGIN_TEXT:
        return this.empty(Utils.EMPTY_BEGIN_TEXT);
      case Regexp.Op.END_TEXT:
        return this.empty(Utils.EMPTY_END_TEXT);
      case Regexp.Op.WORD_BOUNDARY:
        return this.empty(Utils.EMPTY_WORD_BOUNDARY);
      case Regexp.Op.NO_WORD_BOUNDARY:
        return this.empty(Utils.EMPTY_NO_WORD_BOUNDARY);
      case Regexp.Op.PLB:
      case Regexp.Op.NLB:
        return this.lookBehind(this.compile(re.subs[0]), re.lb);
      case Regexp.Op.CAPTURE: {
        const bra = this.cap(re.cap << 1);
        const sub = this.compile(re.subs[0]);
        const ket = this.cap(re.cap << 1 | 1);
        return this.cat(this.cat(bra, sub), ket);
      }
      case Regexp.Op.STAR:
        return this.star(this.compile(re.subs[0]), (re.flags & RE2Flags.NON_GREEDY) !== 0);
      case Regexp.Op.PLUS:
        return this.plus(this.compile(re.subs[0]), (re.flags & RE2Flags.NON_GREEDY) !== 0);
      case Regexp.Op.QUEST:
        return this.quest(this.compile(re.subs[0]), (re.flags & RE2Flags.NON_GREEDY) !== 0);
      case Regexp.Op.CONCAT:
        if (re.subs.length === 0) return this.nop();
        else {
          let f = null;
          for (let sub of re.subs) {
            const f1 = this.compile(sub);
            f = f === null ? f1 : this.cat(f, f1);
          }
          return f;
        }
      case Regexp.Op.ALTERNATE:
        if (re.subs.length === 0) return this.nop();
        else {
          let f = null;
          for (let sub of re.subs) {
            const f1 = this.compile(sub);
            f = f === null ? f1 : this.alt(f, f1);
          }
          return f;
        }
      default:
        throw new RE2JSCompileException("regexp: unhandled case in compile");
    }
  }
};
var Simplify = class Simplify2 {
  static simplify(re) {
    if (re === null) return null;
    switch (re.op) {
      case Regexp.Op.PLB:
      case Regexp.Op.NLB:
      case Regexp.Op.CAPTURE: {
        const sub = Simplify2.simplify(re.subs[0]);
        if (sub !== re.subs[0]) {
          const nre = Regexp.fromRegexp(re);
          nre.runes = [];
          nre.subs = [sub];
          return nre;
        }
        return re;
      }
      case Regexp.Op.CONCAT:
      case Regexp.Op.ALTERNATE: {
        const newSubs = [];
        let changed = false;
        for (let i = 0; i < re.subs.length; i++) {
          const sub = re.subs[i];
          const nsub = Simplify2.simplify(sub);
          if (nsub !== sub) changed = true;
          if (re.op === Regexp.Op.CONCAT) {
            if (nsub.op === Regexp.Op.NO_MATCH) return new Regexp(Regexp.Op.NO_MATCH);
            if (nsub.op === Regexp.Op.EMPTY_MATCH) {
              changed = true;
              continue;
            }
            if (nsub.op === Regexp.Op.CONCAT) {
              changed = true;
              for (let j = 0; j < nsub.subs.length; j++) newSubs.push(nsub.subs[j]);
              continue;
            }
          } else if (re.op === Regexp.Op.ALTERNATE) {
            if (nsub.op === Regexp.Op.NO_MATCH) {
              changed = true;
              continue;
            }
            if (nsub.op === Regexp.Op.ALTERNATE) {
              changed = true;
              for (let j = 0; j < nsub.subs.length; j++) newSubs.push(nsub.subs[j]);
              continue;
            }
          }
          newSubs.push(nsub);
        }
        if (changed) {
          if (newSubs.length === 0) return new Regexp(re.op === Regexp.Op.CONCAT ? Regexp.Op.EMPTY_MATCH : Regexp.Op.NO_MATCH);
          if (newSubs.length === 1) return newSubs[0];
          const nre = Regexp.fromRegexp(re);
          nre.runes = [];
          nre.subs = newSubs;
          return nre;
        }
        return re;
      }
      case Regexp.Op.CHAR_CLASS:
        if (re.runes === null) return re;
        if (re.runes.length === 0) return new Regexp(Regexp.Op.NO_MATCH);
        if (re.runes.length === 2 && re.runes[0] === 0 && re.runes[1] === Unicode.MAX_RUNE) return new Regexp(Regexp.Op.ANY_CHAR);
        if (re.runes.length === 4 && re.runes[0] === 0 && re.runes[1] === Codepoint.CODES.get("\n") - 1 && re.runes[2] === Codepoint.CODES.get("\n") + 1 && re.runes[3] === Unicode.MAX_RUNE) return new Regexp(Regexp.Op.ANY_CHAR_NOT_NL);
        return re;
      case Regexp.Op.STAR:
      case Regexp.Op.PLUS:
      case Regexp.Op.QUEST: {
        const sub = Simplify2.simplify(re.subs[0]);
        return Simplify2.simplify1(re.op, re.flags, sub, re);
      }
      case Regexp.Op.REPEAT: {
        if (re.min === 0 && re.max === 0) return new Regexp(Regexp.Op.EMPTY_MATCH);
        const sub = Simplify2.simplify(re.subs[0]);
        if (re.max === -1) {
          if (re.min === 0) return Simplify2.simplify1(Regexp.Op.STAR, re.flags, sub, null);
          if (re.min === 1) return Simplify2.simplify1(Regexp.Op.PLUS, re.flags, sub, null);
          const nre = new Regexp(Regexp.Op.CONCAT);
          const subs = [];
          for (let i = 0; i < re.min - 1; i++) subs.push(sub);
          subs.push(Simplify2.simplify1(Regexp.Op.PLUS, re.flags, sub, null));
          nre.subs = subs.slice(0);
          return Simplify2.simplify(nre);
        }
        if (re.min === 1 && re.max === 1) return sub;
        let prefixSubs = null;
        if (re.min > 0) {
          prefixSubs = [];
          for (let i = 0; i < re.min; i++) prefixSubs.push(sub);
        }
        if (re.max > re.min) {
          let suffix = Simplify2.simplify1(Regexp.Op.QUEST, re.flags, sub, null);
          for (let i = re.min + 1; i < re.max; i++) {
            const nre2 = new Regexp(Regexp.Op.CONCAT);
            nre2.subs = [sub, suffix];
            suffix = Simplify2.simplify1(Regexp.Op.QUEST, re.flags, nre2, null);
          }
          if (prefixSubs === null) return suffix;
          prefixSubs.push(suffix);
        }
        if (prefixSubs !== null) {
          const prefix = new Regexp(Regexp.Op.CONCAT);
          prefix.subs = prefixSubs.slice(0);
          return Simplify2.simplify(prefix);
        }
        return new Regexp(Regexp.Op.NO_MATCH);
      }
    }
    return re;
  }
  static simplify1(op, flags, sub, re) {
    if (sub.op === Regexp.Op.EMPTY_MATCH) return sub;
    if (sub.op === Regexp.Op.NO_MATCH) {
      if (op === Regexp.Op.PLUS) return sub;
      return new Regexp(Regexp.Op.EMPTY_MATCH);
    }
    if (op === sub.op && (flags & RE2Flags.NON_GREEDY) === (sub.flags & RE2Flags.NON_GREEDY)) return sub;
    if (re !== null && re.op === op && (re.flags & RE2Flags.NON_GREEDY) === (flags & RE2Flags.NON_GREEDY) && sub === re.subs[0]) return re;
    const nre = new Regexp(op);
    nre.flags = flags;
    nre.subs = [sub];
    return nre;
  }
};
var CharGroup = class {
  constructor(sign, cls) {
    this.sign = sign;
    this.cls = cls;
  }
};
var code1 = [48, 57];
var code2 = [
  9,
  10,
  12,
  13,
  32,
  32
];
var code3 = [
  48,
  57,
  65,
  90,
  95,
  95,
  97,
  122
];
var PERL_GROUPS = /* @__PURE__ */ new Map([
  ["\\d", new CharGroup(1, code1)],
  ["\\D", new CharGroup(-1, code1)],
  ["\\s", new CharGroup(1, code2)],
  ["\\S", new CharGroup(-1, code2)],
  ["\\w", new CharGroup(1, code3)],
  ["\\W", new CharGroup(-1, code3)]
]);
var code4 = [
  48,
  57,
  65,
  90,
  97,
  122
];
var code5 = [
  65,
  90,
  97,
  122
];
var code6 = [0, 127];
var code7 = [
  9,
  9,
  32,
  32
];
var code8 = [
  0,
  31,
  127,
  127
];
var code9 = [48, 57];
var code10 = [33, 126];
var code11 = [97, 122];
var code12 = [32, 126];
var code13 = [
  33,
  47,
  58,
  64,
  91,
  96,
  123,
  126
];
var code14 = [
  9,
  13,
  32,
  32
];
var code15 = [65, 90];
var code16 = [
  48,
  57,
  65,
  90,
  95,
  95,
  97,
  122
];
var code17 = [
  48,
  57,
  65,
  70,
  97,
  102
];
var POSIX_GROUPS = /* @__PURE__ */ new Map([
  ["[:alnum:]", new CharGroup(1, code4)],
  ["[:^alnum:]", new CharGroup(-1, code4)],
  ["[:alpha:]", new CharGroup(1, code5)],
  ["[:^alpha:]", new CharGroup(-1, code5)],
  ["[:ascii:]", new CharGroup(1, code6)],
  ["[:^ascii:]", new CharGroup(-1, code6)],
  ["[:blank:]", new CharGroup(1, code7)],
  ["[:^blank:]", new CharGroup(-1, code7)],
  ["[:cntrl:]", new CharGroup(1, code8)],
  ["[:^cntrl:]", new CharGroup(-1, code8)],
  ["[:digit:]", new CharGroup(1, code9)],
  ["[:^digit:]", new CharGroup(-1, code9)],
  ["[:graph:]", new CharGroup(1, code10)],
  ["[:^graph:]", new CharGroup(-1, code10)],
  ["[:lower:]", new CharGroup(1, code11)],
  ["[:^lower:]", new CharGroup(-1, code11)],
  ["[:print:]", new CharGroup(1, code12)],
  ["[:^print:]", new CharGroup(-1, code12)],
  ["[:punct:]", new CharGroup(1, code13)],
  ["[:^punct:]", new CharGroup(-1, code13)],
  ["[:space:]", new CharGroup(1, code14)],
  ["[:^space:]", new CharGroup(-1, code14)],
  ["[:upper:]", new CharGroup(1, code15)],
  ["[:^upper:]", new CharGroup(-1, code15)],
  ["[:word:]", new CharGroup(1, code16)],
  ["[:^word:]", new CharGroup(-1, code16)],
  ["[:xdigit:]", new CharGroup(1, code17)],
  ["[:^xdigit:]", new CharGroup(-1, code17)]
]);
var CharClass = class CharClass2 {
  static charClassToString(r, len) {
    let result = "[";
    for (let i = 0; i < len; i += 2) {
      if (i > 0) result += " ";
      const lo = r[i];
      const hi = r[i + 1];
      if (lo === hi) result += `0x${lo.toString(16)}`;
      else result += `0x${lo.toString(16)}-0x${hi.toString(16)}`;
    }
    result += "]";
    return result;
  }
  static cmp(array, i, pivotFrom, pivotTo) {
    const cmp = array[i] - pivotFrom;
    return cmp !== 0 ? cmp : pivotTo - array[i + 1];
  }
  static qsortIntPair(array, left, right) {
    const pivotIndex = ((left + right) / 2 | 0) & -2;
    const pivotFrom = array[pivotIndex];
    const pivotTo = array[pivotIndex + 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (i < right && CharClass2.cmp(array, i, pivotFrom, pivotTo) < 0) i += 2;
      while (j > left && CharClass2.cmp(array, j, pivotFrom, pivotTo) > 0) j -= 2;
      if (i <= j) {
        if (i !== j) {
          let temp = array[i];
          array[i] = array[j];
          array[j] = temp;
          temp = array[i + 1];
          array[i + 1] = array[j + 1];
          array[j + 1] = temp;
        }
        i += 2;
        j -= 2;
      }
    }
    if (left < j) CharClass2.qsortIntPair(array, left, j);
    if (i < right) CharClass2.qsortIntPair(array, i, right);
  }
  constructor(r = Utils.emptyInts()) {
    this.r = r;
    this.len = r.length;
  }
  toArray() {
    if (this.len === this.r.length) return this.r;
    else return this.r.slice(0, this.len);
  }
  cleanClass() {
    if (this.len < 4) return this;
    CharClass2.qsortIntPair(this.r, 0, this.len - 2);
    let w = 2;
    for (let i = 2; i < this.len; i += 2) {
      const lo = this.r[i];
      const hi = this.r[i + 1];
      if (lo <= this.r[w - 1] + 1) {
        if (hi > this.r[w - 1]) this.r[w - 1] = hi;
        continue;
      }
      this.r[w] = lo;
      this.r[w + 1] = hi;
      w += 2;
    }
    this.len = w;
    return this;
  }
  appendLiteral(x, flags) {
    return (flags & RE2Flags.FOLD_CASE) !== 0 ? this.appendFoldedRange(x, x) : this.appendRange(x, x);
  }
  appendRange(lo, hi) {
    if (this.len > 0) {
      for (let i = 2; i <= 4; i += 2) if (this.len >= i) {
        const rlo = this.r[this.len - i];
        const rhi = this.r[this.len - i + 1];
        if (lo <= rhi + 1 && rlo <= hi + 1) {
          if (lo < rlo) this.r[this.len - i] = lo;
          if (hi > rhi) this.r[this.len - i + 1] = hi;
          return this;
        }
      }
    }
    this.r[this.len++] = lo;
    this.r[this.len++] = hi;
    return this;
  }
  appendFoldedRange(lo, hi) {
    if (lo <= Unicode.MIN_FOLD && hi >= Unicode.MAX_FOLD) return this.appendRange(lo, hi);
    if (hi < Unicode.MIN_FOLD || lo > Unicode.MAX_FOLD) return this.appendRange(lo, hi);
    if (lo < Unicode.MIN_FOLD) {
      this.appendRange(lo, Unicode.MIN_FOLD - 1);
      lo = Unicode.MIN_FOLD;
    }
    if (hi > Unicode.MAX_FOLD) {
      this.appendRange(Unicode.MAX_FOLD + 1, hi);
      hi = Unicode.MAX_FOLD;
    }
    for (let c = lo; c <= hi; c++) {
      this.appendRange(c, c);
      for (let f = Unicode.simpleFold(c); f !== c; f = Unicode.simpleFold(f)) this.appendRange(f, f);
    }
    return this;
  }
  appendClass(x) {
    for (let i = 0; i < x.length; i += 2) this.appendRange(x[i], x[i + 1]);
    return this;
  }
  appendFoldedClass(x) {
    for (let i = 0; i < x.length; i += 2) this.appendFoldedRange(x[i], x[i + 1]);
    return this;
  }
  appendNegatedClass(x) {
    let nextLo = 0;
    for (let i = 0; i < x.length; i += 2) {
      const lo = x[i];
      const hi = x[i + 1];
      if (nextLo <= lo - 1) this.appendRange(nextLo, lo - 1);
      nextLo = hi + 1;
    }
    if (nextLo <= Unicode.MAX_RUNE) this.appendRange(nextLo, Unicode.MAX_RUNE);
    return this;
  }
  appendTable(table2) {
    for (let i = 0; i < table2.length; ++i) {
      const lo = table2.getLo(i);
      const hi = table2.getHi(i);
      const stride = table2.getStride(i);
      if (stride === 1) {
        this.appendRange(lo, hi);
        continue;
      }
      for (let c = lo; c <= hi; c += stride) this.appendRange(c, c);
    }
    return this;
  }
  appendNegatedTable(table2) {
    let nextLo = 0;
    for (let i = 0; i < table2.length; ++i) {
      const lo = table2.getLo(i);
      const hi = table2.getHi(i);
      const stride = table2.getStride(i);
      if (stride === 1) {
        if (nextLo <= lo - 1) this.appendRange(nextLo, lo - 1);
        nextLo = hi + 1;
        continue;
      }
      for (let c = lo; c <= hi; c += stride) {
        if (nextLo <= c - 1) this.appendRange(nextLo, c - 1);
        nextLo = c + 1;
      }
    }
    if (nextLo <= Unicode.MAX_RUNE) this.appendRange(nextLo, Unicode.MAX_RUNE);
    return this;
  }
  appendTableWithSign(table2, sign) {
    return sign < 0 ? this.appendNegatedTable(table2) : this.appendTable(table2);
  }
  negateClass() {
    let nextLo = 0;
    let w = 0;
    for (let i = 0; i < this.len; i += 2) {
      const lo = this.r[i];
      const hi = this.r[i + 1];
      if (nextLo <= lo - 1) {
        this.r[w] = nextLo;
        this.r[w + 1] = lo - 1;
        w += 2;
      }
      nextLo = hi + 1;
    }
    this.len = w;
    if (nextLo <= Unicode.MAX_RUNE) {
      this.r[this.len++] = nextLo;
      this.r[this.len++] = Unicode.MAX_RUNE;
    }
    return this;
  }
  appendClassWithSign(x, sign) {
    return sign < 0 ? this.appendNegatedClass(x) : this.appendClass(x);
  }
  appendGroup(g, foldCase) {
    let cls = g.cls;
    if (foldCase) cls = new CharClass2().appendFoldedClass(cls).cleanClass().toArray();
    return this.appendClassWithSign(cls, g.sign);
  }
  toString() {
    return CharClass2.charClassToString(this.r, this.len);
  }
};
var StringIterator = class {
  constructor(str) {
    this.str = str;
    this.position = 0;
  }
  pos() {
    return this.position;
  }
  rewindTo(pos) {
    this.position = pos;
  }
  more() {
    return this.position < this.str.length;
  }
  peek() {
    return this.str.codePointAt(this.position);
  }
  skip(n) {
    this.position += n;
  }
  skipString(s) {
    this.position += s.length;
  }
  pop() {
    const r = this.str.codePointAt(this.position);
    this.position += Utils.charCount(r);
    return r;
  }
  lookingAt(s) {
    return this.str.startsWith(s, this.position);
  }
  rest() {
    return this.str.substring(this.position);
  }
  from(beforePos) {
    return this.str.substring(beforePos, this.position);
  }
  toString() {
    return this.rest();
  }
};
var Parser = class Parser2 {
  static ERR_INTERNAL_ERROR = "regexp/syntax: internal error";
  static ERR_INVALID_CHAR_RANGE = "invalid character class range";
  static ERR_INVALID_ESCAPE = "invalid escape sequence";
  static ERR_INVALID_NAMED_CAPTURE = "invalid named capture";
  static ERR_INVALID_PERL_OP = "invalid or unsupported Perl syntax";
  static ERR_INVALID_REPEAT_OP = "invalid nested repetition operator";
  static ERR_INVALID_REPEAT_SIZE = "invalid repeat count";
  static ERR_MISSING_BRACKET = "missing closing ]";
  static ERR_MISSING_PAREN = "missing closing )";
  static ERR_MISSING_REPEAT_ARGUMENT = "missing argument to repetition operator";
  static ERR_TRAILING_BACKSLASH = "trailing backslash at end of expression";
  static ERR_DUPLICATE_NAMED_CAPTURE = "duplicate capture group name";
  static ERR_UNEXPECTED_PAREN = "unexpected )";
  static ERR_NESTING_DEPTH = "expression nests too deeply";
  static ERR_LARGE = "expression too large";
  static ERR_INVALID_CAPTURE_IN_LOOKBEHIND = "invalid capture in lookbehind";
  static MAX_HEIGHT = 1e3;
  static MAX_SIZE = 3355443;
  static MAX_RUNES = 33554432;
  static ANY_TABLE = new UnicodeRangeTable(new Uint32Array([
    0,
    Unicode.MAX_RUNE,
    1
  ]));
  static ASCII_TABLE = new UnicodeRangeTable(new Uint32Array([
    0,
    127,
    1
  ]));
  static ASCII_FOLD_TABLE = new UnicodeRangeTable(new Uint32Array([
    0,
    127,
    1,
    383,
    383,
    1,
    8490,
    8490,
    1
  ]));
  static unicodeTable(name) {
    if (name === "Any") return {
      tab: Parser2.ANY_TABLE,
      fold: Parser2.ANY_TABLE,
      sign: 1
    };
    if (name === "Ascii") return {
      tab: Parser2.ASCII_TABLE,
      fold: Parser2.ASCII_FOLD_TABLE,
      sign: 1
    };
    if (name === "Assigned") return {
      tab: UnicodeTables.CATEGORIES.get("Cn"),
      fold: UnicodeTables.CATEGORIES.get("Cn"),
      sign: -1
    };
    if (name === "Lc") return {
      tab: UnicodeTables.CATEGORIES.get("LC"),
      fold: UnicodeTables.FOLD_CATEGORIES.get("LC"),
      sign: 1
    };
    if (UnicodeTables.CATEGORIES.has(name)) return {
      tab: UnicodeTables.CATEGORIES.get(name),
      fold: UnicodeTables.FOLD_CATEGORIES.get(name),
      sign: 1
    };
    if (UnicodeTables.SCRIPTS.has(name)) return {
      tab: UnicodeTables.SCRIPTS.get(name),
      fold: UnicodeTables.FOLD_SCRIPT.get(name),
      sign: 1
    };
    return null;
  }
  static minFoldRune(r) {
    if (r < Unicode.MIN_FOLD || r > Unicode.MAX_FOLD) return r;
    let min = r;
    const r0 = r;
    for (r = Unicode.simpleFold(r); r !== r0; r = Unicode.simpleFold(r)) if (min > r) min = r;
    return min;
  }
  static leadingRegexp(re) {
    if (re.op === Regexp.Op.EMPTY_MATCH) return null;
    if (re.op === Regexp.Op.CONCAT && re.subs.length > 0) {
      const sub = re.subs[0];
      if (sub.op === Regexp.Op.EMPTY_MATCH) return null;
      return sub;
    }
    return re;
  }
  static literalRegexp(s, flags) {
    const re = new Regexp(Regexp.Op.LITERAL);
    re.flags = flags;
    re.runes = Utils.stringToRunes(s);
    return re;
  }
  /**
  * Parse regular expression pattern {@code pattern} with mode flags {@code flags}.
  * @param {string} pattern
  * @param {number} flags
  */
  static parse(pattern, flags) {
    return new Parser2(pattern, flags).parseInternal();
  }
  static parseRepeat(t) {
    const start = t.pos();
    if (!t.more() || !t.lookingAt("{")) return -1;
    t.skip(1);
    const min = Parser2.parseInt(t);
    if (min === -1) return -1;
    if (!t.more()) return -1;
    let max;
    if (!t.lookingAt(",")) max = min;
    else {
      t.skip(1);
      if (!t.more()) return -1;
      if (t.lookingAt("}")) max = -1;
      else if ((max = Parser2.parseInt(t)) === -1) return -1;
    }
    if (!t.more() || !t.lookingAt("}")) return -1;
    t.skip(1);
    if (min < 0 || min > 1e3 || max === -2 || max > 1e3 || max >= 0 && min > max) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_REPEAT_SIZE, t.from(start));
    return min << 16 | max & Unicode.MAX_BMP;
  }
  static isValidCaptureName(name) {
    if (name.length === 0) return false;
    for (let i = 0; i < name.length; i++) {
      const c = name.codePointAt(i);
      if (c !== Codepoint.CODES.get("_") && !Utils.isalnum(c)) return false;
    }
    return true;
  }
  static parseInt(t) {
    const start = t.pos();
    while (t.more() && t.peek() >= Codepoint.CODES.get("0") && t.peek() <= Codepoint.CODES.get("9")) t.skip(1);
    const n = t.from(start);
    if (n.length === 0 || n.length > 1 && n.codePointAt(0) === Codepoint.CODES.get("0")) return -1;
    if (n.length > 8) return -2;
    return parseInt(n, 10);
  }
  static isCharClass(re) {
    return re.op === Regexp.Op.LITERAL && re.runes.length === 1 || re.op === Regexp.Op.CHAR_CLASS || re.op === Regexp.Op.ANY_CHAR_NOT_NL || re.op === Regexp.Op.ANY_CHAR;
  }
  static matchRune(re, r) {
    switch (re.op) {
      case Regexp.Op.LITERAL:
        return re.runes.length === 1 && re.runes[0] === r;
      case Regexp.Op.CHAR_CLASS:
        for (let i = 0; i < re.runes.length; i += 2) if (re.runes[i] <= r && r <= re.runes[i + 1]) return true;
        return false;
      case Regexp.Op.ANY_CHAR_NOT_NL:
        return r !== Codepoint.CODES.get("\n");
      case Regexp.Op.ANY_CHAR:
        return true;
    }
    return false;
  }
  static mergeCharClass(dst, src) {
    switch (dst.op) {
      case Regexp.Op.ANY_CHAR:
        break;
      case Regexp.Op.ANY_CHAR_NOT_NL:
        if (Parser2.matchRune(src, Codepoint.CODES.get("\n"))) dst.op = Regexp.Op.ANY_CHAR;
        break;
      case Regexp.Op.CHAR_CLASS:
        if (src.op === Regexp.Op.LITERAL) dst.runes = new CharClass(dst.runes).appendLiteral(src.runes[0], src.flags).toArray();
        else dst.runes = new CharClass(dst.runes).appendClass(src.runes).toArray();
        break;
      case Regexp.Op.LITERAL:
        if (src.runes[0] === dst.runes[0] && src.flags === dst.flags) break;
        dst.op = Regexp.Op.CHAR_CLASS;
        dst.runes = new CharClass().appendLiteral(dst.runes[0], dst.flags).appendLiteral(src.runes[0], src.flags).toArray();
        break;
    }
  }
  static parseEscape(t) {
    const startPos = t.pos();
    t.skip(1);
    if (!t.more()) throw new RE2JSSyntaxException(Parser2.ERR_TRAILING_BACKSLASH);
    let c = t.pop();
    bigswitch: switch (c) {
      case Codepoint.CODES.get("1"):
      case Codepoint.CODES.get("2"):
      case Codepoint.CODES.get("3"):
      case Codepoint.CODES.get("4"):
      case Codepoint.CODES.get("5"):
      case Codepoint.CODES.get("6"):
      case Codepoint.CODES.get("7"):
        if (!t.more() || t.peek() < Codepoint.CODES.get("0") || t.peek() > Codepoint.CODES.get("7")) break;
      case Codepoint.CODES.get("0"): {
        let r = c - Codepoint.CODES.get("0");
        for (let i = 1; i < 3; i++) {
          if (!t.more() || t.peek() < Codepoint.CODES.get("0") || t.peek() > Codepoint.CODES.get("7")) break;
          r = r * 8 + t.peek() - Codepoint.CODES.get("0");
          t.skip(1);
        }
        return r;
      }
      case Codepoint.CODES.get("x"): {
        if (!t.more()) break;
        c = t.pop();
        if (c === Codepoint.CODES.get("{")) {
          let nhex = 0;
          let r = 0;
          while (true) {
            if (!t.more()) break bigswitch;
            c = t.pop();
            if (c === Codepoint.CODES.get("}")) break;
            const v = Utils.unhex(c);
            if (v < 0) break bigswitch;
            r = r * 16 + v;
            if (r > Unicode.MAX_RUNE) break bigswitch;
            nhex++;
          }
          if (nhex === 0) break bigswitch;
          return r;
        }
        const x = Utils.unhex(c);
        if (!t.more()) break;
        c = t.pop();
        const y = Utils.unhex(c);
        if (x < 0 || y < 0) break;
        return x * 16 + y;
      }
      case Codepoint.CODES.get("a"):
        return Codepoint.CODES.get("\x07");
      case Codepoint.CODES.get("f"):
        return Codepoint.CODES.get("\f");
      case Codepoint.CODES.get("n"):
        return Codepoint.CODES.get("\n");
      case Codepoint.CODES.get("r"):
        return Codepoint.CODES.get("\r");
      case Codepoint.CODES.get("t"):
        return Codepoint.CODES.get("	");
      case Codepoint.CODES.get("v"):
        return Codepoint.CODES.get("\v");
      default:
        if (c <= Unicode.MAX_ASCII && !Utils.isalnum(c)) return c;
        break;
    }
    throw new RE2JSSyntaxException(Parser2.ERR_INVALID_ESCAPE, t.from(startPos));
  }
  static parseClassChar(t, wholeClassPos) {
    if (!t.more()) throw new RE2JSSyntaxException(Parser2.ERR_MISSING_BRACKET, t.from(wholeClassPos));
    if (t.lookingAt("\\")) return Parser2.parseEscape(t);
    return t.pop();
  }
  static concatRunes(x, y) {
    for (let i = 0; i < y.length; i++) x.push(y[i]);
    return x;
  }
  static hasCapture(re) {
    if (re === null) return false;
    if (re.op === Regexp.Op.CAPTURE) return true;
    if (re.subs) {
      for (let sub of re.subs) if (Parser2.hasCapture(sub)) return true;
    }
    return false;
  }
  constructor(wholeRegexp, flags = 0) {
    this.wholeRegexp = wholeRegexp;
    this.flags = flags;
    this.numCap = 0;
    this.namedGroups = /* @__PURE__ */ Object.create(null);
    this.stack = [];
    this.free = null;
    this.numRegexp = 0;
    this.numRunes = 0;
    this.repeats = 0;
    this.height = null;
    this.size = null;
    this.nlb = 0;
  }
  newRegexp(op) {
    let re = this.free;
    if (re !== null && re.subs !== null && re.subs.length > 0) {
      this.free = re.subs[0];
      re.reinit();
      re.op = op;
    } else {
      re = new Regexp(op);
      this.numRegexp += 1;
    }
    return re;
  }
  reuse(re) {
    if (this.height !== null && this.height.has(re)) this.height.delete(re);
    if (re.subs !== null && re.subs.length > 0) re.subs[0] = this.free;
    this.free = re;
  }
  checkLimits(re) {
    if (this.numRunes > Parser2.MAX_RUNES) throw new RE2JSSyntaxException(Parser2.ERR_LARGE);
    this.checkSize(re);
    this.checkHeight(re);
  }
  checkSize(re) {
    if (this.size === null) {
      if (this.repeats === 0) this.repeats = 1;
      if (re.op === Regexp.Op.REPEAT) {
        let n = re.max;
        if (n === -1) n = re.min;
        if (n <= 0) n = 1;
        if (n > Math.floor(Parser2.MAX_SIZE / this.repeats)) this.repeats = Parser2.MAX_SIZE;
        else this.repeats *= n;
      }
      if (this.numRegexp < Math.floor(Parser2.MAX_SIZE / this.repeats)) return;
      this.size = /* @__PURE__ */ new Map();
      for (let reEx of this.stack) this.checkSize(reEx);
    }
    if (this.calcSize(re, true) > Parser2.MAX_SIZE) throw new RE2JSSyntaxException(Parser2.ERR_LARGE);
  }
  calcSize(re, force = false) {
    if (!force && this.size !== null) {
      if (this.size.has(re)) return this.size.get(re);
    }
    let size = 0;
    switch (re.op) {
      case Regexp.Op.LITERAL:
        size = re.runes.length;
        break;
      case Regexp.Op.PLB:
      case Regexp.Op.NLB:
      case Regexp.Op.CAPTURE:
      case Regexp.Op.STAR:
        size = 2 + this.calcSize(re.subs[0]);
        break;
      case Regexp.Op.PLUS:
      case Regexp.Op.QUEST:
        size = 1 + this.calcSize(re.subs[0]);
        break;
      case Regexp.Op.CONCAT:
        for (let sub of re.subs) size = size + this.calcSize(sub);
        break;
      case Regexp.Op.ALTERNATE:
        for (let sub of re.subs) size = size + this.calcSize(sub);
        if (re.subs.length > 1) size = size + re.subs.length - 1;
        break;
      case Regexp.Op.REPEAT: {
        let sub = this.calcSize(re.subs[0]);
        if (re.max === -1) {
          if (re.min === 0) size = 2 + sub;
          else size = 1 + re.min * sub;
          break;
        }
        size = re.max * sub + (re.max - re.min);
        break;
      }
    }
    size = Math.max(1, size);
    if (this.size === null) this.size = /* @__PURE__ */ new Map();
    this.size.set(re, size);
    return size;
  }
  checkHeight(re) {
    if (this.numRegexp < Parser2.MAX_HEIGHT) return;
    if (this.height === null) {
      this.height = /* @__PURE__ */ new Map();
      for (let reEx of this.stack) this.checkHeight(reEx);
    }
    if (this.calcHeight(re, true) > Parser2.MAX_HEIGHT) throw new RE2JSSyntaxException(Parser2.ERR_NESTING_DEPTH);
  }
  calcHeight(re, force = false) {
    if (!force && this.height !== null) {
      if (this.height.has(re)) return this.height.get(re);
    }
    let h = 1;
    for (let sub of re.subs) {
      const hsub = this.calcHeight(sub);
      if (h < 1 + hsub) h = 1 + hsub;
    }
    if (this.height === null) this.height = /* @__PURE__ */ new Map();
    this.height.set(re, h);
    return h;
  }
  pop() {
    return this.stack.pop();
  }
  popToPseudo() {
    const n = this.stack.length;
    let i = n;
    while (i > 0 && !Regexp.isPseudoOp(this.stack[i - 1].op)) i--;
    const r = this.stack.slice(i, n);
    this.stack = this.stack.slice(0, i);
    return r;
  }
  push(re) {
    this.numRunes += re.runes.length;
    if (re.op === Regexp.Op.CHAR_CLASS && re.runes.length === 2 && re.runes[0] === re.runes[1]) {
      if (this.maybeConcat(re.runes[0], this.flags & ~RE2Flags.FOLD_CASE)) return null;
      re.op = Regexp.Op.LITERAL;
      re.runes = [re.runes[0]];
      re.flags = this.flags & ~RE2Flags.FOLD_CASE;
    } else if (re.op === Regexp.Op.CHAR_CLASS && re.runes.length === 4 && re.runes[0] === re.runes[1] && re.runes[2] === re.runes[3] && Unicode.simpleFold(re.runes[0]) === re.runes[2] && Unicode.simpleFold(re.runes[2]) === re.runes[0] || re.op === Regexp.Op.CHAR_CLASS && re.runes.length === 2 && re.runes[0] + 1 === re.runes[1] && Unicode.simpleFold(re.runes[0]) === re.runes[1] && Unicode.simpleFold(re.runes[1]) === re.runes[0]) {
      if (this.maybeConcat(re.runes[0], this.flags | RE2Flags.FOLD_CASE)) return null;
      re.op = Regexp.Op.LITERAL;
      re.runes = [re.runes[0]];
      re.flags = this.flags | RE2Flags.FOLD_CASE;
    } else this.maybeConcat(-1, 0);
    this.stack.push(re);
    this.checkLimits(re);
    return re;
  }
  maybeConcat(r, flags) {
    const n = this.stack.length;
    if (n < 2) return false;
    const re1 = this.stack[n - 1];
    const re2 = this.stack[n - 2];
    if (re1.op !== Regexp.Op.LITERAL || re2.op !== Regexp.Op.LITERAL || (re1.flags & RE2Flags.FOLD_CASE) !== (re2.flags & RE2Flags.FOLD_CASE)) return false;
    re2.runes = Parser2.concatRunes(re2.runes, re1.runes);
    if (r >= 0) {
      re1.runes = [r];
      re1.flags = flags;
      return true;
    }
    this.pop();
    this.reuse(re1);
    return false;
  }
  newLiteral(r, flags) {
    const re = this.newRegexp(Regexp.Op.LITERAL);
    re.flags = flags;
    if ((flags & RE2Flags.FOLD_CASE) !== 0) r = Parser2.minFoldRune(r);
    re.runes = [r];
    return re;
  }
  literal(r) {
    this.push(this.newLiteral(r, this.flags));
  }
  op(op) {
    const re = this.newRegexp(op);
    re.flags = this.flags;
    return this.push(re);
  }
  repeat(op, min, max, beforePos, t, lastRepeatPos) {
    let flags = this.flags;
    if ((flags & RE2Flags.PERL_X) !== 0) {
      if (t.more() && t.lookingAt("?")) {
        t.skip(1);
        flags ^= RE2Flags.NON_GREEDY;
      }
      if (lastRepeatPos !== -1) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_REPEAT_OP, t.from(lastRepeatPos));
    }
    const n = this.stack.length;
    if (n === 0) throw new RE2JSSyntaxException(Parser2.ERR_MISSING_REPEAT_ARGUMENT, t.from(beforePos));
    const sub = this.stack[n - 1];
    if (Regexp.isPseudoOp(sub.op)) throw new RE2JSSyntaxException(Parser2.ERR_MISSING_REPEAT_ARGUMENT, t.from(beforePos));
    const re = this.newRegexp(op);
    re.min = min;
    re.max = max;
    re.flags = flags;
    re.subs = [sub];
    this.stack[n - 1] = re;
    this.checkLimits(re);
    if (op === Regexp.Op.REPEAT && (min >= 2 || max >= 2) && !this.repeatIsValid(re, 1e3)) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_REPEAT_SIZE, t.from(beforePos));
  }
  repeatIsValid(re, n) {
    if (re.op === Regexp.Op.REPEAT) {
      let m = re.max;
      if (m === 0) return true;
      if (m < 0) m = re.min;
      if (m > n) return false;
      if (m > 0) n = Math.trunc(n / m);
    }
    for (let sub of re.subs) if (!this.repeatIsValid(sub, n)) return false;
    return true;
  }
  concat() {
    this.maybeConcat(-1, 0);
    const subs = this.popToPseudo();
    if (subs.length === 0) return this.push(this.newRegexp(Regexp.Op.EMPTY_MATCH));
    return this.push(this.collapse(subs, Regexp.Op.CONCAT));
  }
  alternate() {
    const subs = this.popToPseudo();
    if (subs.length > 0) this.cleanAlt(subs[subs.length - 1]);
    if (subs.length === 0) return this.push(this.newRegexp(Regexp.Op.NO_MATCH));
    return this.push(this.collapse(subs, Regexp.Op.ALTERNATE));
  }
  cleanAlt(re) {
    if (re.op === Regexp.Op.CHAR_CLASS) {
      re.runes = new CharClass(re.runes).cleanClass().toArray();
      if (re.runes.length === 2 && re.runes[0] === 0 && re.runes[1] === Unicode.MAX_RUNE) {
        re.runes = [];
        re.op = Regexp.Op.ANY_CHAR;
      } else if (re.runes.length === 4 && re.runes[0] === 0 && re.runes[1] === Codepoint.CODES.get("\n") - 1 && re.runes[2] === Codepoint.CODES.get("\n") + 1 && re.runes[3] === Unicode.MAX_RUNE) {
        re.runes = [];
        re.op = Regexp.Op.ANY_CHAR_NOT_NL;
      }
    }
  }
  collapse(subs, op) {
    if (subs.length === 1) return subs[0];
    let len = 0;
    for (let sub of subs) len += sub.op === op ? sub.subs.length : 1;
    let newsubs = new Array(len).fill(null);
    let i = 0;
    for (let sub of subs) if (sub.op === op) {
      for (let j = 0; j < sub.subs.length; j++) newsubs[i++] = sub.subs[j];
      this.reuse(sub);
    } else newsubs[i++] = sub;
    let re = this.newRegexp(op);
    re.subs = newsubs;
    if (op === Regexp.Op.ALTERNATE) {
      re.subs = this.factor(re.subs);
      if (re.subs.length === 1) {
        const old = re;
        re = re.subs[0];
        this.reuse(old);
      }
    }
    return re;
  }
  factor(array) {
    if (array.length < 2) return array;
    let s = 0;
    let lensub = array.length;
    let lenout = 0;
    let str = null;
    let strlen = 0;
    let strflags = 0;
    let start = 0;
    for (let i = 0; i <= lensub; i++) {
      let istr = null;
      let istrlen = 0;
      let iflags = 0;
      if (i < lensub) {
        let re = array[s + i];
        if (re.op === Regexp.Op.CONCAT && re.subs.length > 0) re = re.subs[0];
        if (re.op === Regexp.Op.LITERAL) {
          istr = re.runes;
          istrlen = re.runes.length;
          iflags = re.flags & RE2Flags.FOLD_CASE;
        }
        if (iflags === strflags) {
          let same = 0;
          while (same < strlen && same < istrlen && str[same] === istr[same]) same++;
          if (same > 0) {
            strlen = same;
            continue;
          }
        }
      }
      if (i === start) {
      } else if (i === start + 1) array[lenout++] = array[s + start];
      else {
        const prefix = this.newRegexp(Regexp.Op.LITERAL);
        prefix.flags = strflags;
        prefix.runes = str.slice(0, strlen);
        for (let j = start; j < i; j++) {
          array[s + j] = this.removeLeadingString(array[s + j], strlen);
          this.checkLimits(array[s + j]);
        }
        const suffix = this.collapse(array.slice(s + start, s + i), Regexp.Op.ALTERNATE);
        const re = this.newRegexp(Regexp.Op.CONCAT);
        re.subs = [prefix, suffix];
        array[lenout++] = re;
      }
      start = i;
      str = istr;
      strlen = istrlen;
      strflags = iflags;
    }
    lensub = lenout;
    s = 0;
    start = 0;
    lenout = 0;
    let first = null;
    for (let i = 0; i <= lensub; i++) {
      let ifirst = null;
      if (i < lensub) {
        ifirst = Parser2.leadingRegexp(array[s + i]);
        if (first !== null && first.equals(ifirst) && (Parser2.isCharClass(first) || first.op === Regexp.Op.REPEAT && first.min === first.max && Parser2.isCharClass(first.subs[0]))) continue;
      }
      if (i === start) {
      } else if (i === start + 1) array[lenout++] = array[s + start];
      else {
        const prefix = first;
        for (let j = start; j < i; j++) {
          const reuse = j !== start;
          array[s + j] = this.removeLeadingRegexp(array[s + j], reuse);
          this.checkLimits(array[s + j]);
        }
        const suffix = this.collapse(array.slice(s + start, s + i), Regexp.Op.ALTERNATE);
        const re = this.newRegexp(Regexp.Op.CONCAT);
        re.subs = [prefix, suffix];
        array[lenout++] = re;
      }
      start = i;
      first = ifirst;
    }
    lensub = lenout;
    s = 0;
    start = 0;
    lenout = 0;
    for (let i = 0; i <= lensub; i++) {
      if (i < lensub && Parser2.isCharClass(array[s + i])) continue;
      if (i === start) {
      } else if (i === start + 1) array[lenout++] = array[s + start];
      else {
        let max = start;
        for (let j = start + 1; j < i; j++) {
          const subMax = array[s + max];
          const subJ = array[s + j];
          if (subMax.op < subJ.op || subMax.op === subJ.op && (subMax.runes !== null ? subMax.runes.length : 0) < (subJ.runes !== null ? subJ.runes.length : 0)) max = j;
        }
        const tmp = array[s + start];
        array[s + start] = array[s + max];
        array[s + max] = tmp;
        for (let j = start + 1; j < i; j++) {
          Parser2.mergeCharClass(array[s + start], array[s + j]);
          this.reuse(array[s + j]);
        }
        this.cleanAlt(array[s + start]);
        array[lenout++] = array[s + start];
      }
      if (i < lensub) array[lenout++] = array[s + i];
      start = i + 1;
    }
    lensub = lenout;
    s = 0;
    start = 0;
    lenout = 0;
    for (let i = 0; i < lensub; ++i) {
      if (i + 1 < lensub && array[s + i].op === Regexp.Op.EMPTY_MATCH && array[s + i + 1].op === Regexp.Op.EMPTY_MATCH) continue;
      array[lenout++] = array[s + i];
    }
    lensub = lenout;
    s = 0;
    return array.slice(s, lensub);
  }
  removeLeadingString(re, n) {
    if (re.op === Regexp.Op.CONCAT && re.subs.length > 0) {
      const sub = this.removeLeadingString(re.subs[0], n);
      re.subs[0] = sub;
      if (sub.op === Regexp.Op.EMPTY_MATCH) {
        this.reuse(sub);
        switch (re.subs.length) {
          case 0:
          case 1:
            re.op = Regexp.Op.EMPTY_MATCH;
            re.subs = Regexp.emptySubs();
            break;
          case 2: {
            const old = re;
            re = re.subs[1];
            this.reuse(old);
            break;
          }
          default:
            re.subs = re.subs.slice(1, re.subs.length);
            break;
        }
      }
      return re;
    }
    if (re.op === Regexp.Op.LITERAL) {
      re.runes = re.runes.slice(n, re.runes.length);
      if (re.runes.length === 0) re.op = Regexp.Op.EMPTY_MATCH;
    }
    return re;
  }
  removeLeadingRegexp(re, reuse) {
    if (re.op === Regexp.Op.CONCAT && re.subs.length > 0) {
      if (reuse) this.reuse(re.subs[0]);
      re.subs = re.subs.slice(1, re.subs.length);
      switch (re.subs.length) {
        case 0:
          re.op = Regexp.Op.EMPTY_MATCH;
          re.subs = Regexp.emptySubs();
          break;
        case 1: {
          const old = re;
          re = re.subs[0];
          this.reuse(old);
          break;
        }
      }
      return re;
    }
    if (reuse) this.reuse(re);
    return this.newRegexp(Regexp.Op.EMPTY_MATCH);
  }
  parseInternal() {
    if ((this.flags & RE2Flags.LITERAL) !== 0) return Parser2.literalRegexp(this.wholeRegexp, this.flags);
    let lastRepeatPos = -1;
    let min = -1;
    let max = -1;
    const t = new StringIterator(this.wholeRegexp);
    while (t.more()) {
      let repeatPos = -1;
      bigswitch: switch (t.peek()) {
        case Codepoint.CODES.get("("):
          if ((this.flags & RE2Flags.LOOKBEHIND) !== 0) {
            if (t.lookingAt("(?<=")) {
              this.parsePosLookBehind();
              t.skip(4);
              break;
            }
            if (t.lookingAt("(?<!")) {
              this.parseNegLookBehind();
              t.skip(4);
              break;
            }
          }
          if ((this.flags & RE2Flags.PERL_X) !== 0 && t.lookingAt("(?")) {
            this.parsePerlFlags(t);
            break;
          }
          this.op(Regexp.Op.LEFT_PAREN).cap = ++this.numCap;
          t.skip(1);
          break;
        case Codepoint.CODES.get("|"):
          this.parseVerticalBar();
          t.skip(1);
          break;
        case Codepoint.CODES.get(")"):
          this.parseRightParen();
          t.skip(1);
          break;
        case Codepoint.CODES.get("^"):
          if ((this.flags & RE2Flags.ONE_LINE) !== 0) this.op(Regexp.Op.BEGIN_TEXT);
          else this.op(Regexp.Op.BEGIN_LINE);
          t.skip(1);
          break;
        case Codepoint.CODES.get("$"):
          if ((this.flags & RE2Flags.ONE_LINE) !== 0) this.op(Regexp.Op.END_TEXT).flags |= RE2Flags.WAS_DOLLAR;
          else this.op(Regexp.Op.END_LINE);
          t.skip(1);
          break;
        case Codepoint.CODES.get("."):
          if ((this.flags & RE2Flags.DOT_NL) !== 0) this.op(Regexp.Op.ANY_CHAR);
          else this.op(Regexp.Op.ANY_CHAR_NOT_NL);
          t.skip(1);
          break;
        case Codepoint.CODES.get("["):
          this.parseClass(t);
          break;
        case Codepoint.CODES.get("*"):
        case Codepoint.CODES.get("+"):
        case Codepoint.CODES.get("?"): {
          repeatPos = t.pos();
          let op = null;
          switch (t.pop()) {
            case Codepoint.CODES.get("*"):
              op = Regexp.Op.STAR;
              break;
            case Codepoint.CODES.get("+"):
              op = Regexp.Op.PLUS;
              break;
            case Codepoint.CODES.get("?"):
              op = Regexp.Op.QUEST;
              break;
          }
          this.repeat(op, min, max, repeatPos, t, lastRepeatPos);
          break;
        }
        case Codepoint.CODES.get("{"): {
          repeatPos = t.pos();
          const minMax = Parser2.parseRepeat(t);
          if (minMax < 0) {
            t.rewindTo(repeatPos);
            this.literal(t.pop());
            break;
          }
          min = minMax >> 16;
          max = (minMax & Unicode.MAX_BMP) << 16 >> 16;
          this.repeat(Regexp.Op.REPEAT, min, max, repeatPos, t, lastRepeatPos);
          break;
        }
        case Codepoint.CODES.get("\\"): {
          const savedPos = t.pos();
          t.skip(1);
          if ((this.flags & RE2Flags.PERL_X) !== 0 && t.more()) switch (t.pop()) {
            case Codepoint.CODES.get("A"):
              this.op(Regexp.Op.BEGIN_TEXT);
              break bigswitch;
            case Codepoint.CODES.get("b"):
              this.op(Regexp.Op.WORD_BOUNDARY);
              break bigswitch;
            case Codepoint.CODES.get("B"):
              this.op(Regexp.Op.NO_WORD_BOUNDARY);
              break bigswitch;
            case Codepoint.CODES.get("C"):
              throw new RE2JSSyntaxException(Parser2.ERR_INVALID_ESCAPE, "\\C");
            case Codepoint.CODES.get("Q"): {
              let lit = t.rest();
              const i = lit.indexOf("\\E");
              if (i >= 0) {
                lit = lit.substring(0, i);
                t.skipString(lit);
                t.skipString("\\E");
              } else t.skipString(lit);
              let j = 0;
              while (j < lit.length) {
                const codepoint = lit.codePointAt(j);
                this.literal(codepoint);
                j += Utils.charCount(codepoint);
              }
              break bigswitch;
            }
            case Codepoint.CODES.get("z"):
              this.op(Regexp.Op.END_TEXT);
              break bigswitch;
            default:
              t.rewindTo(savedPos);
              break;
          }
          else t.rewindTo(savedPos);
          const re = this.newRegexp(Regexp.Op.CHAR_CLASS);
          re.flags = this.flags;
          if (t.lookingAt("\\p") || t.lookingAt("\\P")) {
            const cc2 = new CharClass();
            if (this.parseUnicodeClass(t, cc2)) {
              re.runes = cc2.toArray();
              this.push(re);
              break bigswitch;
            }
          }
          const cc = new CharClass();
          if (this.parsePerlClassEscape(t, cc)) {
            re.runes = cc.toArray();
            this.push(re);
            break bigswitch;
          }
          t.rewindTo(savedPos);
          this.reuse(re);
          this.literal(Parser2.parseEscape(t));
          break;
        }
        default:
          this.literal(t.pop());
          break;
      }
      lastRepeatPos = repeatPos;
    }
    this.concat();
    if (this.swapVerticalBar()) this.pop();
    this.alternate();
    if (this.stack.length !== 1) throw new RE2JSSyntaxException(Parser2.ERR_MISSING_PAREN, this.wholeRegexp);
    this.stack[0].namedGroups = this.namedGroups;
    return this.stack[0];
  }
  parsePerlFlags(t) {
    const startPos = t.pos();
    const s = t.rest();
    if (s.startsWith("(?P<") || s.startsWith("(?<")) {
      const begin = s.charAt(2) === "P" ? 4 : 3;
      const end = s.indexOf(">");
      if (end < 0) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_NAMED_CAPTURE, s);
      const name = s.substring(begin, end);
      t.skipString(name);
      t.skip(begin + 1);
      if (!Parser2.isValidCaptureName(name)) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_NAMED_CAPTURE, s.substring(0, end + 1));
      const re = this.op(Regexp.Op.LEFT_PAREN);
      re.cap = ++this.numCap;
      if (this.namedGroups[name]) throw new RE2JSSyntaxException(Parser2.ERR_DUPLICATE_NAMED_CAPTURE, name);
      this.namedGroups[name] = this.numCap;
      re.name = name;
      return;
    }
    t.skip(2);
    let flags = this.flags;
    let sign = 1;
    let sawFlag = false;
    loop: while (t.more()) {
      const c = t.pop();
      switch (c) {
        case Codepoint.CODES.get("i"):
          flags |= RE2Flags.FOLD_CASE;
          sawFlag = true;
          break;
        case Codepoint.CODES.get("m"):
          flags &= ~RE2Flags.ONE_LINE;
          sawFlag = true;
          break;
        case Codepoint.CODES.get("s"):
          flags |= RE2Flags.DOT_NL;
          sawFlag = true;
          break;
        case Codepoint.CODES.get("U"):
          flags |= RE2Flags.NON_GREEDY;
          sawFlag = true;
          break;
        case Codepoint.CODES.get("-"):
          if (sign < 0) break loop;
          sign = -1;
          flags = ~flags;
          sawFlag = false;
          break;
        case Codepoint.CODES.get(":"):
        case Codepoint.CODES.get(")"):
          if (sign < 0) {
            if (!sawFlag) break loop;
            flags = ~flags;
          }
          if (c === Codepoint.CODES.get(":")) this.op(Regexp.Op.LEFT_PAREN);
          this.flags = flags;
          return;
        default:
          break loop;
      }
    }
    throw new RE2JSSyntaxException(Parser2.ERR_INVALID_PERL_OP, t.from(startPos));
  }
  parsePosLookBehind() {
    const re = this.newRegexp(Regexp.Op.LEFT_PAREN);
    re.flags = this.flags;
    re.lb = ++this.nlb;
    return this.push(re);
  }
  parseNegLookBehind() {
    const re = this.newRegexp(Regexp.Op.LEFT_PAREN);
    re.flags = this.flags;
    re.lb = -++this.nlb;
    return this.push(re);
  }
  parseVerticalBar() {
    this.concat();
    if (!this.swapVerticalBar()) this.op(Regexp.Op.VERTICAL_BAR);
  }
  swapVerticalBar() {
    const n = this.stack.length;
    if (n >= 3 && this.stack[n - 2].op === Regexp.Op.VERTICAL_BAR && Parser2.isCharClass(this.stack[n - 1]) && Parser2.isCharClass(this.stack[n - 3])) {
      let re1 = this.stack[n - 1];
      let re3 = this.stack[n - 3];
      if (re1.op > re3.op) {
        const tmp = re3;
        re3 = re1;
        re1 = tmp;
        this.stack[n - 3] = re3;
      }
      Parser2.mergeCharClass(re3, re1);
      this.reuse(re1);
      this.pop();
      return true;
    }
    if (n >= 2) {
      const re1 = this.stack[n - 1];
      const re2 = this.stack[n - 2];
      if (re2.op === Regexp.Op.VERTICAL_BAR) {
        if (n >= 3) this.cleanAlt(this.stack[n - 3]);
        this.stack[n - 2] = re1;
        this.stack[n - 1] = re2;
        return true;
      }
    }
    return false;
  }
  parseRightParen() {
    this.concat();
    if (this.swapVerticalBar()) this.pop();
    this.alternate();
    if (this.stack.length < 2) throw new RE2JSSyntaxException(Parser2.ERR_UNEXPECTED_PAREN, this.wholeRegexp);
    const re1 = this.pop();
    const re2 = this.pop();
    if (re2.op !== Regexp.Op.LEFT_PAREN) throw new RE2JSSyntaxException(Parser2.ERR_UNEXPECTED_PAREN, this.wholeRegexp);
    this.flags = re2.flags;
    if (re2.lb !== 0) {
      if (Parser2.hasCapture(re1)) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CAPTURE_IN_LOOKBEHIND, this.wholeRegexp);
      if (re2.lb > 0) re2.op = Regexp.Op.PLB;
      else re2.op = Regexp.Op.NLB;
      re2.subs = [re1];
      this.push(re2);
      return;
    }
    if (re2.cap === 0) this.push(re1);
    else {
      re2.op = Regexp.Op.CAPTURE;
      re2.subs = [re1];
      this.push(re2);
    }
  }
  parsePerlClassEscape(t, cc) {
    const beforePos = t.pos();
    if ((this.flags & RE2Flags.PERL_X) === 0 || !t.more() || t.pop() !== Codepoint.CODES.get("\\") || !t.more()) return false;
    t.pop();
    const p = t.from(beforePos);
    const g = PERL_GROUPS.has(p) ? PERL_GROUPS.get(p) : null;
    if (g === null) return false;
    cc.appendGroup(g, (this.flags & RE2Flags.FOLD_CASE) !== 0);
    return true;
  }
  parseNamedClass(t, cc) {
    const cls = t.rest();
    const i = cls.indexOf(":]");
    if (i < 0) return false;
    const name = cls.substring(0, i + 2);
    t.skipString(name);
    const g = POSIX_GROUPS.has(name) ? POSIX_GROUPS.get(name) : null;
    if (g === null) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, name);
    cc.appendGroup(g, (this.flags & RE2Flags.FOLD_CASE) !== 0);
    return true;
  }
  parseUnicodeClass(t, cc) {
    const startPos = t.pos();
    if ((this.flags & RE2Flags.UNICODE_GROUPS) === 0 || !t.lookingAt("\\p") && !t.lookingAt("\\P")) return false;
    t.skip(1);
    let sign = 1;
    let c = t.pop();
    if (c === Codepoint.CODES.get("P")) sign = -1;
    if (!t.more()) {
      t.rewindTo(startPos);
      throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, t.rest());
    }
    c = t.pop();
    let name;
    if (c !== Codepoint.CODES.get("{")) name = Utils.runeToString(c);
    else {
      const rest = t.rest();
      const end = rest.indexOf("}");
      if (end < 0) {
        t.rewindTo(startPos);
        throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, t.rest());
      }
      name = rest.substring(0, end);
      t.skipString(name);
      t.skip(1);
    }
    if (!(name.length === 0) && name.codePointAt(0) === Codepoint.CODES.get("^")) {
      sign = 0 - sign;
      name = name.substring(1);
    }
    const pair = Parser2.unicodeTable(name);
    if (pair === null) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, t.from(startPos));
    if (pair.sign < 0) sign = 0 - sign;
    const tab = pair.tab;
    const fold = pair.fold;
    if ((this.flags & RE2Flags.FOLD_CASE) === 0 || fold === null) cc.appendTableWithSign(tab, sign);
    else {
      const tmp = new CharClass().appendTable(tab).appendTable(fold).cleanClass().toArray();
      cc.appendClassWithSign(tmp, sign);
    }
    return true;
  }
  parseClass(t) {
    const startPos = t.pos();
    t.skip(1);
    const re = this.newRegexp(Regexp.Op.CHAR_CLASS);
    re.flags = this.flags;
    const cc = new CharClass();
    let sign = 1;
    if (t.more() && t.lookingAt("^")) {
      sign = -1;
      t.skip(1);
      if ((this.flags & RE2Flags.CLASS_NL) === 0) cc.appendRange(Codepoint.CODES.get("\n"), Codepoint.CODES.get("\n"));
    }
    let first = true;
    while (!t.more() || t.peek() !== Codepoint.CODES.get("]") || first) {
      if (t.more() && t.lookingAt("-") && (this.flags & RE2Flags.PERL_X) === 0 && !first) {
        const s = t.rest();
        if (s === "-" || !s.startsWith("-]")) {
          t.rewindTo(startPos);
          throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, t.rest());
        }
      }
      first = false;
      const beforePos = t.pos();
      if (t.lookingAt("[:")) {
        if (this.parseNamedClass(t, cc)) continue;
        t.rewindTo(beforePos);
      }
      if (this.parseUnicodeClass(t, cc)) continue;
      if (this.parsePerlClassEscape(t, cc)) continue;
      t.rewindTo(beforePos);
      const lo = Parser2.parseClassChar(t, startPos);
      let hi = lo;
      if (t.more() && t.lookingAt("-")) {
        t.skip(1);
        if (t.more() && t.lookingAt("]")) t.skip(-1);
        else {
          hi = Parser2.parseClassChar(t, startPos);
          if (hi < lo) throw new RE2JSSyntaxException(Parser2.ERR_INVALID_CHAR_RANGE, t.from(beforePos));
        }
      }
      if ((this.flags & RE2Flags.FOLD_CASE) === 0) cc.appendRange(lo, hi);
      else cc.appendFoldedRange(lo, hi);
    }
    t.skip(1);
    cc.cleanClass();
    if (sign < 0) cc.negateClass();
    re.runes = cc.toArray();
    this.push(re);
  }
};
var RE2 = class RE22 {
  static initTest(expr) {
    const re2 = RE22.compile(expr);
    const res = new RE22(re2.expr, re2.prog, re2.numSubexp, re2.longest);
    res.cond = re2.cond;
    res.prefix = re2.prefix;
    res.prefixUTF8 = re2.prefixUTF8;
    res.prefixComplete = re2.prefixComplete;
    res.prefixRune = re2.prefixRune;
    res.prefilter = re2.prefilter;
    return res;
  }
  /**
  * Parses a regular expression and returns, if successful, an {@code RE2} instance that can be
  * used to match against text.
  *
  * When matching against text, the regexp returns a match that begins as early as possible in the
  * input (leftmost), and among those it chooses the one that a backtracking search would have
  * found first. This so-called leftmost-first matching is the same semantics that Perl, Python,
  * and other implementations use, although this package implements it without the expense of
  * backtracking. For POSIX leftmost-longest matching, see {@link #compilePOSIX}.
  */
  static compile(expr) {
    return RE22.compileImpl(expr, RE2Flags.PERL, false);
  }
  /**
  * {@code compilePOSIX} is like {@link #compile} but restricts the regular expression to POSIX ERE
  * (egrep) syntax and changes the match semantics to leftmost-longest.
  *
  * That is, when matching against text, the regexp returns a match that begins as early as
  * possible in the input (leftmost), and among those it chooses a match that is as long as
  * possible. This so-called leftmost-longest matching is the same semantics that early regular
  * expression implementations used and that POSIX specifies.
  *
  * However, there can be multiple leftmost-longest matches, with different submatch choices, and
  * here this package diverges from POSIX. Among the possible leftmost-longest matches, this
  * package chooses the one that a backtracking search would have found first, while POSIX
  * specifies that the match be chosen to maximize the length of the first subexpression, then the
  * second, and so on from left to right. The POSIX rule is computationally prohibitive and not
  * even well-defined. See http://swtch.com/~rsc/regexp/regexp2.html#posix
  */
  static compilePOSIX(expr) {
    return RE22.compileImpl(expr, RE2Flags.POSIX, true);
  }
  static compileImpl(expr, mode, longest) {
    let re = Parser.parse(expr, mode);
    const maxCap = re.maxCap();
    re = Simplify.simplify(re);
    const prefilter = PrefilterTree.build(re);
    const prog = Compiler.compileRegexp(re);
    const re2 = new RE22(expr, prog, maxCap, longest);
    re2.prefilter = prefilter.type === Prefilter.Type.NONE ? null : prefilter;
    const [prefixCompl, prefixStr] = prog.prefix();
    re2.prefixComplete = prefixCompl;
    re2.prefix = prefixStr;
    re2.prefixUTF8 = Utils.stringToUtf8ByteArray(re2.prefix);
    if (re2.prefix.length > 0) re2.prefixRune = re2.prefix.codePointAt(0);
    re2.namedGroups = re.namedGroups;
    return re2;
  }
  /**
  * Returns true iff textual regular expression {@code pattern} matches string {@code s}.
  *
  * More complicated queries need to use {@link #compile} and the full {@code RE2} interface.
  */
  static match(pattern, s) {
    return RE22.compile(pattern).match(s);
  }
  constructor(expr, prog, numSubexp = 0, longest = 0) {
    this.expr = expr;
    this.prog = prog;
    this.numSubexp = numSubexp;
    this.longest = longest;
    this.cond = prog.startCond();
    this.prefix = null;
    this.prefixUTF8 = null;
    this.prefixComplete = false;
    this.prefixRune = 0;
    this.machinePool = [];
    this.dfa = new DFA(this.prog);
    this.onepass = OnePass.compile(this.prog);
    this.prefilter = null;
  }
  matchPrefixComplete(input, pos, anchor, ncap) {
    if ((anchor === RE2Flags.ANCHOR_START || anchor === RE2Flags.ANCHOR_BOTH) && pos !== 0) return null;
    let matchStart = -1;
    let matchEnd = -1;
    const pLen = input.prefixLength(this);
    if (anchor === RE2Flags.UNANCHORED) {
      const idx = input.index(this, pos);
      if (idx < 0) return null;
      matchStart = pos + idx;
      matchEnd = matchStart + pLen;
    } else if (anchor === RE2Flags.ANCHOR_BOTH) {
      if (input.endPos() !== pLen) return null;
      if (input.index(this, 0) !== 0) return null;
      matchStart = 0;
      matchEnd = pLen;
    } else if (anchor === RE2Flags.ANCHOR_START) {
      if (input.index(this, 0) !== 0) return null;
      matchStart = 0;
      matchEnd = pLen;
    }
    if (matchStart < 0) return null;
    if (ncap > 0) {
      const matchcap = new Int32Array(ncap).fill(-1);
      matchcap[0] = matchStart;
      matchcap[1] = matchEnd;
      return Array.from(matchcap);
    }
    return [];
  }
  executeEngine(input, pos, anchor, ncap) {
    if (this.prefixComplete && (ncap === 0 || this.numSubexp === 0)) return this.matchPrefixComplete(input, pos, anchor, ncap);
    if (this.prefilter !== null && anchor === RE2Flags.UNANCHORED) {
      if (!this.prefilter.eval(input, pos)) return null;
    }
    if (this.onepass !== null) return OnePass.execute(this, input, pos, anchor, ncap);
    if (ncap > 0) {
      if (this.prog.numLb === 0 && input.endPos() <= Backtracker.maxBitStateLen(this.prog)) return Backtracker.execute(this, input, pos, anchor, ncap);
      return this.doExecuteNFA(input, pos, anchor, ncap);
    }
    if (this.prog.numLb === 0) {
      const dfaResult = this.dfa.match(input, pos, anchor);
      if (dfaResult !== null) return dfaResult ? [] : null;
      if (input.endPos() <= Backtracker.maxBitStateLen(this.prog)) return Backtracker.execute(this, input, pos, anchor, ncap);
    }
    return this.doExecuteNFA(input, pos, anchor, ncap);
  }
  /**
  * Returns the number of parenthesized subexpressions in this regular expression.
  */
  numberOfCapturingGroups() {
    return this.numSubexp;
  }
  /**
  * Returns the number of instructions in this compiled regular expression program.
  */
  numberOfInstructions() {
    return this.prog.numInst();
  }
  get() {
    return this.machinePool.length > 0 ? this.machinePool.pop() : null;
  }
  reset() {
    this.machinePool.length = 0;
  }
  put(m) {
    this.machinePool.push(m);
  }
  toString() {
    return this.expr;
  }
  doExecuteNFA(input, pos, anchor, ncap) {
    let m = this.get();
    if (!m) m = Machine.fromRE2(this);
    m.init(ncap);
    const cap = m.match(input, pos, anchor) ? m.submatches() : null;
    this.put(m);
    return cap;
  }
  match(s) {
    return this.executeEngine(MachineInput.fromUTF16(s), 0, RE2Flags.UNANCHORED, 0) !== null;
  }
  /**
  * Matches the regular expression against input starting at position start and ending at position
  * end, with the given anchoring. Records the submatch boundaries in group, which is [start, end)
  * pairs of byte offsets. The number of boundaries needed is inferred from the size of the group
  * array. It is most efficient not to ask for submatch boundaries.
  *
  * @param input the input byte array
  * @param start the beginning position in the input
  * @param end the end position in the input
  * @param anchor the anchoring flag (UNANCHORED, ANCHOR_START, ANCHOR_BOTH)
  * @param group the array to fill with submatch positions
  * @param ngroup the number of array pairs to fill in
  * @returns true if a match was found
  */
  matchWithGroup(input, start, end, anchor, ngroup) {
    if (!(input instanceof MatcherInputBase)) if (Utils.isByteArray(input)) input = MatcherInput.utf8(input);
    else input = MatcherInput.utf16(input);
    return this.matchMachineInput(input, start, end, anchor, ngroup);
  }
  matchMachineInput(input, start, end, anchor, ngroup) {
    if (start > end) return [false, null];
    const machineInput = input.isUTF16Encoding() ? MachineInput.fromUTF16(input.asCharSequence(), 0, end) : MachineInput.fromUTF8(input.asBytes(), 0, end);
    const groupMatch = this.executeEngine(machineInput, start, anchor, 2 * ngroup);
    if (groupMatch === null) return [false, null];
    return [true, groupMatch];
  }
  /**
  * Returns true iff this regexp matches the UTF-8 byte array {@code b}.
  */
  matchUTF8(b) {
    return this.executeEngine(MachineInput.fromUTF8(b), 0, RE2Flags.UNANCHORED, 0) !== null;
  }
  /**
  * Returns a copy of {@code src} in which all matches for this regexp have been replaced by
  * {@code repl}. No support is provided for expressions (e.g. {@code \1} or {@code $1}) in the
  * replacement string.
  */
  replaceAll(src, repl) {
    return this.replaceAllFunc(src, () => repl, 2 * src.length + 1);
  }
  /**
  * Returns a copy of {@code src} in which only the first match for this regexp has been replaced
  * by {@code repl}. No support is provided for expressions (e.g. {@code \1} or {@code $1}) in the
  * replacement string.
  */
  replaceFirst(src, repl) {
    return this.replaceAllFunc(src, () => repl, 1);
  }
  /**
  * Returns a copy of {@code src} in which at most {@code maxReplaces} matches for this regexp have
  * been replaced by the return value of of function {@code repl} (whose first argument is the
  * matched string). No support is provided for expressions (e.g. {@code \1} or {@code $1}) in the
  * replacement string.
  */
  replaceAllFunc(src, replFunc, maxReplaces) {
    let lastMatchEnd = 0;
    let searchPos = 0;
    let out = "";
    const input = MachineInput.fromUTF16(src);
    let numReplaces = 0;
    while (searchPos <= src.length) {
      const a = this.executeEngine(input, searchPos, RE2Flags.UNANCHORED, 2);
      if (a === null || a.length === 0) break;
      out += src.substring(lastMatchEnd, a[0]);
      if (a[1] > lastMatchEnd || a[0] === 0) {
        out += replFunc(src.substring(a[0], a[1]));
        numReplaces++;
      }
      lastMatchEnd = a[1];
      const width = input.step(searchPos) & 7;
      if (searchPos + width > a[1]) searchPos += width;
      else if (searchPos + 1 > a[1]) searchPos++;
      else searchPos = a[1];
      if (numReplaces >= maxReplaces) break;
    }
    out += src.substring(lastMatchEnd);
    return out;
  }
  pad(a) {
    if (a === null) return null;
    let n = (1 + this.numSubexp) * 2;
    if (a.length < n) {
      let a2 = new Array(n).fill(-1);
      for (let i = 0; i < a.length; i++) a2[i] = a[i];
      a = a2;
    }
    return a;
  }
  allMatches(input, n, deliverFun = (v) => v) {
    let result = [];
    const end = input.endPos();
    if (n < 0) n = end + 1;
    let pos = 0;
    let i = 0;
    let prevMatchEnd = -1;
    while (i < n && pos <= end) {
      const matches = this.executeEngine(input, pos, RE2Flags.UNANCHORED, this.prog.numCap);
      if (matches === null || matches.length === 0) break;
      let accept = true;
      if (matches[1] === pos) {
        if (matches[0] === prevMatchEnd) accept = false;
        const r = input.step(pos);
        if (r < 0) pos = end + 1;
        else pos += r & 7;
      } else pos = matches[1];
      prevMatchEnd = matches[1];
      if (accept) {
        result.push(deliverFun(this.pad(matches)));
        i++;
      }
    }
    return result;
  }
  /**
  * Returns an array holding the text of the leftmost match in {@code b} of this regular
  * expression.
  *
  * A return value of null indicates no match.
  */
  findUTF8(b) {
    const a = this.executeEngine(MachineInput.fromUTF8(b), 0, RE2Flags.UNANCHORED, 2);
    if (a === null) return null;
    return b.slice(a[0], a[1]);
  }
  /**
  * Returns a two-element array of integers defining the location of the leftmost match in
  * {@code b} of this regular expression. The match itself is at {@code b[loc[0]...loc[1]]}.
  *
  * A return value of null indicates no match.
  */
  findUTF8Index(b) {
    const a = this.executeEngine(MachineInput.fromUTF8(b), 0, RE2Flags.UNANCHORED, 2);
    if (a === null) return null;
    return a.slice(0, 2);
  }
  /**
  * Returns a string holding the text of the leftmost match in {@code s} of this regular
  * expression.
  *
  * If there is no match, the return value is an empty string, but it will also be empty if the
  * regular expression successfully matches an empty string. Use {@link #findIndex} or
  * {@link #findSubmatch} if it is necessary to distinguish these cases.
  */
  find(s) {
    const a = this.executeEngine(MachineInput.fromUTF16(s), 0, RE2Flags.UNANCHORED, 2);
    if (a === null) return "";
    return s.substring(a[0], a[1]);
  }
  /**
  * Returns a two-element array of integers defining the location of the leftmost match in
  * {@code s} of this regular expression. The match itself is at
  * {@code s.substring(loc[0], loc[1])}.
  *
  * A return value of null indicates no match.
  */
  findIndex(s) {
    return this.executeEngine(MachineInput.fromUTF16(s), 0, RE2Flags.UNANCHORED, 2);
  }
  /**
  * Returns an array of arrays the text of the leftmost match of the regular expression in
  * {@code b} and the matches, if any, of its subexpressions, as defined by the <a
  * href='#submatch'>Submatch</a> description above.
  *
  * A return value of null indicates no match.
  */
  findUTF8Submatch(b) {
    const a = this.executeEngine(MachineInput.fromUTF8(b), 0, RE2Flags.UNANCHORED, this.prog.numCap);
    if (a === null) return null;
    const ret = new Array(1 + this.numSubexp).fill(null);
    for (let i = 0; i < ret.length; i++) if (2 * i < a.length && a[2 * i] >= 0) ret[i] = b.slice(a[2 * i], a[2 * i + 1]);
    return ret;
  }
  /**
  * Returns an array holding the index pairs identifying the leftmost match of this regular
  * expression in {@code b} and the matches, if any, of its subexpressions, as defined by the the
  * <a href='#submatch'>Submatch</a> and <a href='#index'>Index</a> descriptions above.
  *
  * A return value of null indicates no match.
  */
  findUTF8SubmatchIndex(b) {
    return this.pad(this.executeEngine(MachineInput.fromUTF8(b), 0, RE2Flags.UNANCHORED, this.prog.numCap));
  }
  /**
  * Returns an array of strings holding the text of the leftmost match of the regular expression in
  * {@code s} and the matches, if any, of its subexpressions, as defined by the <a
  * href='#submatch'>Submatch</a> description above.
  *
  * A return value of null indicates no match.
  */
  findSubmatch(s) {
    const a = this.executeEngine(MachineInput.fromUTF16(s), 0, RE2Flags.UNANCHORED, this.prog.numCap);
    if (a === null) return null;
    const ret = new Array(1 + this.numSubexp).fill(null);
    for (let i = 0; i < ret.length; i++) if (2 * i < a.length && a[2 * i] >= 0) ret[i] = s.substring(a[2 * i], a[2 * i + 1]);
    return ret;
  }
  /**
  * Returns an array holding the index pairs identifying the leftmost match of this regular
  * expression in {@code s} and the matches, if any, of its subexpressions, as defined by the <a
  * href='#submatch'>Submatch</a> description above.
  *
  * A return value of null indicates no match.
  */
  findSubmatchIndex(s) {
    return this.pad(this.executeEngine(MachineInput.fromUTF16(s), 0, RE2Flags.UNANCHORED, this.prog.numCap));
  }
  /**
  * {@code findAllUTF8()} is the <a href='#all'>All</a> version of {@link #findUTF8}; it returns a
  * list of up to {@code n} successive matches of the expression, as defined by the <a
  * href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  *
  * TODO(adonovan): think about defining a byte slice view class, like a read-only Go slice backed
  * by |b|.
  */
  findAllUTF8(b, n) {
    const result = this.allMatches(MachineInput.fromUTF8(b), n, (match) => b.slice(match[0], match[1]));
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllUTF8Index} is the <a href='#all'>All</a> version of {@link #findUTF8Index}; it
  * returns a list of up to {@code n} successive matches of the expression, as defined by the <a
  * href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllUTF8Index(b, n) {
    const result = this.allMatches(MachineInput.fromUTF8(b), n, (match) => match.slice(0, 2));
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAll} is the <a href='#all'>All</a> version of {@link #find}; it returns a list of up
  * to {@code n} successive matches of the expression, as defined by the <a href='#all'>All</a>
  * description above.
  *
  * A return value of null indicates no match.
  */
  findAll(s, n) {
    const result = this.allMatches(MachineInput.fromUTF16(s), n, (match) => s.substring(match[0], match[1]));
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllIndex} is the <a href='#all'>All</a> version of {@link #findIndex}; it returns a
  * list of up to {@code n} successive matches of the expression, as defined by the <a
  * href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllIndex(s, n) {
    const result = this.allMatches(MachineInput.fromUTF16(s), n, (match) => match.slice(0, 2));
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllUTF8Submatch} is the <a href='#all'>All</a> version of {@link #findUTF8Submatch};
  * it returns a list of up to {@code n} successive matches of the expression, as defined by the <a
  * href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllUTF8Submatch(b, n) {
    const result = this.allMatches(MachineInput.fromUTF8(b), n, (match) => {
      let slice = new Array(match.length / 2 | 0).fill(null);
      for (let j = 0; j < slice.length; j++) if (match[2 * j] >= 0) slice[j] = b.slice(match[2 * j], match[2 * j + 1]);
      return slice;
    });
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllUTF8SubmatchIndex} is the <a href='#all'>All</a> version of
  * {@link #findUTF8SubmatchIndex}; it returns a list of up to {@code n} successive matches of the
  * expression, as defined by the <a href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllUTF8SubmatchIndex(b, n) {
    const result = this.allMatches(MachineInput.fromUTF8(b), n);
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllSubmatch} is the <a href='#all'>All</a> version of {@link #findSubmatch}; it
  * returns a list of up to {@code n} successive matches of the expression, as defined by the <a
  * href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllSubmatch(s, n) {
    const result = this.allMatches(MachineInput.fromUTF16(s), n, (match) => {
      let slice = new Array(match.length / 2 | 0).fill(null);
      for (let j = 0; j < slice.length; j++) if (match[2 * j] >= 0) slice[j] = s.substring(match[2 * j], match[2 * j + 1]);
      return slice;
    });
    if (result.length === 0) return null;
    return result;
  }
  /**
  * {@code findAllSubmatchIndex} is the <a href='#all'>All</a> version of
  * {@link #findSubmatchIndex}; it returns a list of up to {@code n} successive matches of the
  * expression, as defined by the <a href='#all'>All</a> description above.
  *
  * A return value of null indicates no match.
  */
  findAllSubmatchIndex(s, n) {
    const result = this.allMatches(MachineInput.fromUTF16(s), n);
    if (result.length === 0) return null;
    return result;
  }
};
var RE2Set = class RE2Set2 {
  /** @type {number} */
  static UNANCHORED = RE2Flags.UNANCHORED;
  /** @type {number} */
  static ANCHOR_START = RE2Flags.ANCHOR_START;
  /** @type {number} */
  static ANCHOR_BOTH = RE2Flags.ANCHOR_BOTH;
  /**
  * Constructs a new RE2Set with the specified anchor mode and flags.
  * @param {number} [anchor=RE2Set.UNANCHORED] - The anchoring mode (e.g., RE2Set.UNANCHORED).
  * @param {number} [flags=0] - The public flags to apply to all patterns in the set.
  * @param {number} [maxMem=8388608] - The maximum memory in bytes to use for the DFA (default 8MB).
  */
  constructor(anchor = RE2Set2.UNANCHORED, flags = 0, maxMem = 8388608) {
    this.anchor = anchor;
    this.jsFlags = flags;
    this.maxMem = maxMem;
    let re2Flags = RE2Flags.PERL;
    if ((flags & PublicFlags.DISABLE_UNICODE_GROUPS) !== 0) re2Flags &= ~RE2Flags.UNICODE_GROUPS;
    if ((flags & PublicFlags.LOOKBEHINDS) !== 0) re2Flags |= RE2Flags.LOOKBEHIND;
    this.re2Flags = re2Flags;
    this.regexps = [];
    this.prog = null;
    this.dfa = null;
    this.dummyRe2 = null;
  }
  /**
  * Adds a new regular expression pattern to the set.
  * Patterns cannot be added after the set has been compiled.
  * @param {string} pattern - The regular expression pattern to add.
  * @returns {number} The integer index assigned to the added pattern.
  * @throws {RE2JSCompileException} If patterns are added after compilation.
  */
  add(pattern) {
    if (this.prog) throw new RE2JSCompileException("Cannot add patterns after compile");
    let fregex = pattern;
    if ((this.jsFlags & PublicFlags.CASE_INSENSITIVE) !== 0) fregex = `(?i)${fregex}`;
    if ((this.jsFlags & PublicFlags.DOTALL) !== 0) fregex = `(?s)${fregex}`;
    if ((this.jsFlags & PublicFlags.MULTILINE) !== 0) fregex = `(?m)${fregex}`;
    const re = Parser.parse(fregex, this.re2Flags);
    this.regexps.push(Simplify.simplify(re));
    return this.regexps.length - 1;
  }
  /**
  * Compiles the added patterns into a single state machine.
  * This is automatically called on the first match if not called explicitly.
  * @returns {void}
  */
  compile() {
    if (this.prog) return;
    this.prog = Compiler.compileSet(this.regexps);
    this.dfa = new DFA(this.prog, this.maxMem);
    this.dummyRe2 = {
      prog: this.prog,
      cond: this.prog.startCond(),
      prefix: "",
      prefixRune: 0,
      longest: false
    };
  }
  /**
  * Matches the input against the compiled set of regular expressions.
  * @param {string|number[]|Uint8Array} input - The input string or UTF-8 byte array to match against.
  * @returns {number[]} An array of indices representing the patterns that successfully matched the input.
  */
  match(input) {
    if (!this.prog) this.compile();
    const machineInput = Utils.isByteArray(input) ? MachineInput.fromUTF8(input) : MachineInput.fromUTF16(input);
    let internalAnchor = RE2Flags.UNANCHORED;
    if (this.anchor === RE2Set2.ANCHOR_START) internalAnchor = RE2Flags.ANCHOR_START;
    else if (this.anchor === RE2Set2.ANCHOR_BOTH) internalAnchor = RE2Flags.ANCHOR_BOTH;
    const dfaResult = this.dfa.matchSet(machineInput, 0, internalAnchor);
    if (dfaResult !== null) return dfaResult;
    const machine = Machine.fromRE2(this.dummyRe2);
    machine.init(0);
    return machine.matchSet(machineInput, 0, internalAnchor);
  }
};
var TranslateRegExpString = class TranslateRegExpString2 {
  static isHexadecimal(ch) {
    return "0" <= ch && ch <= "9" || "A" <= ch && ch <= "F" || "a" <= ch && ch <= "f";
  }
  static translate(data) {
    let prefixFlags = "";
    if (data instanceof RegExp) {
      if (data.ignoreCase) prefixFlags += "i";
      if (data.multiline) prefixFlags += "m";
      if (data.dotAll) prefixFlags += "s";
      data = data.source;
    }
    if (typeof data !== "string") return data;
    let result = "";
    let changed = false;
    let size = data.length;
    if (size === 0) {
      result = "(?:)";
      changed = true;
    }
    let inCharClass = false;
    let i = 0;
    while (i < size) {
      let ch = data[i];
      if (ch === "\\") {
        if (i + 1 < size) {
          ch = data[i + 1];
          switch (ch) {
            case "\\":
              result += "\\\\";
              i += 2;
              continue;
            case "c":
              if (i + 2 < size) {
                let code = data[i + 2].charCodeAt(0);
                if (code >= 65 && code <= 90 || code >= 97 && code <= 122) {
                  let val = code % 32;
                  result += "\\x";
                  result += (val >> 4).toString(16).toUpperCase();
                  result += (val & 15).toString(16).toUpperCase();
                  i += 3;
                  changed = true;
                  continue;
                }
              }
              result += "c";
              i += 2;
              changed = true;
              continue;
            case "u":
              if (i + 2 < size) {
                if (data[i + 2] === "{") {
                  let j = i + 3;
                  let hasHex = false;
                  let closed = false;
                  while (j < size) {
                    const hexChar = data[j];
                    if (hexChar === "}") {
                      closed = true;
                      break;
                    }
                    if (!TranslateRegExpString2.isHexadecimal(hexChar)) break;
                    hasHex = true;
                    j++;
                  }
                  if (closed && hasHex) {
                    result += "\\x";
                    i += 2;
                    changed = true;
                    continue;
                  }
                } else if (i + 5 < size) {
                  let isHex4 = true;
                  for (let j = 0; j < 4; j++) if (!TranslateRegExpString2.isHexadecimal(data[i + 2 + j])) {
                    isHex4 = false;
                    break;
                  }
                  if (isHex4) {
                    result += "\\x{" + data.substring(i + 2, i + 6) + "}";
                    i += 6;
                    changed = true;
                    continue;
                  }
                }
              }
              result += "u";
              i += 2;
              changed = true;
              continue;
            case "x": {
              let isValidHex = false;
              if (i + 2 < size && data[i + 2] === "{") {
                let j = i + 3;
                let hasHex = false;
                let closed = false;
                while (j < size) {
                  const hexChar = data[j];
                  if (hexChar === "}") {
                    closed = true;
                    break;
                  }
                  if (!TranslateRegExpString2.isHexadecimal(hexChar)) break;
                  hasHex = true;
                  j++;
                }
                if (closed && hasHex) isValidHex = true;
              } else if (i + 3 < size && TranslateRegExpString2.isHexadecimal(data[i + 2]) && TranslateRegExpString2.isHexadecimal(data[i + 3])) isValidHex = true;
              if (isValidHex) {
                result += "\\x";
                i += 2;
              } else {
                result += "x";
                i += 2;
                changed = true;
              }
              continue;
            }
            case "n":
            case "r":
            case "t":
            case "a":
            case "f":
            case "v":
            case "d":
            case "D":
            case "s":
            case "S":
            case "w":
            case "W":
            case "b":
            case "B":
            case "p":
            case "P":
            case "A":
            case "z":
            case "Q":
            case "E":
            case "0":
            case "1":
            case "2":
            case "3":
            case "4":
            case "5":
            case "6":
            case "7":
              result += "\\" + ch;
              i += 2;
              continue;
            default: {
              let cp2 = data.codePointAt(i + 1);
              if (cp2 >= 48 && cp2 <= 57 || cp2 >= 65 && cp2 <= 90 || cp2 >= 97 && cp2 <= 122) {
                let symSize2 = Utils.charCount(cp2);
                result += data.substring(i + 1, i + 1 + symSize2);
                i += symSize2 + 1;
                changed = true;
              } else {
                result += "\\";
                let symSize2 = Utils.charCount(cp2);
                result += data.substring(i + 1, i + 1 + symSize2);
                i += symSize2 + 1;
              }
              continue;
            }
          }
        }
      } else if (ch === "/") {
        result += "\\/";
        i += 1;
        changed = true;
        continue;
      } else if (ch === "[") inCharClass = true;
      else if (ch === "]") inCharClass = false;
      else if (!inCharClass && ch === "(" && i + 2 < size && data[i + 1] === "?" && data[i + 2] === "<") {
        if (i + 3 < size && !"=!>)".includes(data[i + 3])) {
          result += "(?P<";
          i += 3;
          changed = true;
          continue;
        }
      }
      let cp = data.codePointAt(i);
      let symSize = Utils.charCount(cp);
      result += data.substring(i, i + symSize);
      i += symSize;
    }
    const finalResult = changed ? result : data;
    if (prefixFlags.length > 0) return `(?${prefixFlags})${finalResult}`;
    return finalResult;
  }
};
var RE2JS = class RE2JS2 {
  /**
  * Flag: case insensitive matching.
  */
  static CASE_INSENSITIVE = PublicFlags.CASE_INSENSITIVE;
  /**
  * Flag: dot ({@code .}) matches all characters, including newline.
  */
  static DOTALL = PublicFlags.DOTALL;
  /**
  * Flag: multiline matching: {@code ^} and {@code $} match at beginning and end of line, not just
  * beginning and end of input.
  */
  static MULTILINE = PublicFlags.MULTILINE;
  /**
  * Flag: Unicode groups (e.g. {@code \p\ Greek\} ) will be syntax errors.
  */
  static DISABLE_UNICODE_GROUPS = PublicFlags.DISABLE_UNICODE_GROUPS;
  /**
  * Flag: matches longest possible string.
  */
  static LONGEST_MATCH = PublicFlags.LONGEST_MATCH;
  /**
  * Flag: enable linear-time captureless lookbehinds.
  */
  static LOOKBEHINDS = PublicFlags.LOOKBEHINDS;
  /**
  * Returns a literal pattern string for the specified string.
  *
  * This method produces a string that can be used to create a <code>RE2JS</code> that would
  * match the string <code>s</code> as if it were a literal pattern.
  *
  * Metacharacters or escape sequences in the input sequence will be given no special meaning.
  *
  * @param {string} str The string to be literalized
  * @returns {string} A literal string replacement
  */
  static quote(str) {
    return Utils.quoteMeta(str);
  }
  /**
  * Quotes '\' and '$' in {@code str}, so that the returned string could be used in
  * replacement methods as a literal replacement of {@code str}.
  *
  * This is a convenience delegation to {@link Matcher.quoteReplacement}.
  *
  * @param {string} str the string to be quoted
  * @param {boolean} [javaMode=false] whether the replacement will be used in javaMode
  * @returns {string} the quoted string
  */
  static quoteReplacement(str, javaMode = false) {
    return Matcher.quoteReplacement(str, javaMode);
  }
  /**
  * Translates a given regular expression string to ensure compatibility with RE2JS.
  *
  * This function preprocesses the input regex string by applying necessary transformations,
  * such as escaping special characters (e.g., `/`), converting named capture groups to
  * RE2JS-compatible syntax, and handling Unicode sequences properly. It ensures that the
  * resulting regex is safe and properly formatted before compilation.
  *
  * @param {string|RegExp} expr - The regular expression string to be translated.
  * @returns {string} - The transformed regular expression string, ready for compilation.
  */
  static translateRegExp(expr) {
    return TranslateRegExpString.translate(expr);
  }
  /**
  * Helper: create new RE2JS with given regex and flags. Flregex is the regex with flags applied.
  * @param {string} regex
  * @param {number} [flags=0]
  * @returns {RE2JS}
  */
  static compile(regex, flags = 0) {
    let fregex = regex;
    if ((flags & RE2JS2.CASE_INSENSITIVE) !== 0) fregex = `(?i)${fregex}`;
    if ((flags & RE2JS2.DOTALL) !== 0) fregex = `(?s)${fregex}`;
    if ((flags & RE2JS2.MULTILINE) !== 0) fregex = `(?m)${fregex}`;
    if ((flags & ~(RE2JS2.MULTILINE | RE2JS2.DOTALL | RE2JS2.CASE_INSENSITIVE | RE2JS2.DISABLE_UNICODE_GROUPS | RE2JS2.LONGEST_MATCH | RE2JS2.LOOKBEHINDS)) !== 0) throw new RE2JSFlagsException("Flags should only be a combination of MULTILINE, DOTALL, CASE_INSENSITIVE, DISABLE_UNICODE_GROUPS, LONGEST_MATCH, LOOKBEHINDS");
    let re2Flags = RE2Flags.PERL;
    if ((flags & RE2JS2.DISABLE_UNICODE_GROUPS) !== 0) re2Flags &= ~RE2Flags.UNICODE_GROUPS;
    if ((flags & RE2JS2.LOOKBEHINDS) !== 0) re2Flags |= RE2Flags.LOOKBEHIND;
    const p = new RE2JS2(regex, flags);
    p.re2Input = RE2.compileImpl(fregex, re2Flags, (flags & RE2JS2.LONGEST_MATCH) !== 0);
    return p;
  }
  /**
  * Matches a string against a regular expression.
  *
  * @param {string} regex the regular expression
  * @param {string|number[]|Uint8Array} input the input
  * @returns {boolean} true if the regular expression matches the entire input
  * @throws RE2JSSyntaxException if the regular expression is malformed
  */
  static matches(regex, input) {
    return RE2JS2.compile(regex).testExact(input);
  }
  /**
  * This is visible for testing.
  * @private
  */
  static initTest(pattern, flags, re2) {
    if (pattern == null) throw new Error("pattern is null");
    if (re2 == null) throw new Error("re2 is null");
    const p = new RE2JS2(pattern, flags);
    p.re2Input = re2;
    return p;
  }
  /**
  *
  * @param {string} pattern
  * @param {number} flags
  */
  constructor(pattern, flags) {
    this.patternInput = pattern;
    this.flagsInput = flags;
    this.re2Input = null;
  }
  /**
  * Releases memory used by internal caches associated with this pattern. Does not change the
  * observable behaviour. Useful for tests that detect memory leaks via allocation tracking.
  */
  reset() {
    this.re2Input.reset();
  }
  /**
  * Returns the flags used in the constructor.
  * @returns {number}
  */
  flags() {
    return this.flagsInput;
  }
  /**
  * Returns the pattern used in the constructor.
  * @returns {string}
  */
  pattern() {
    return this.patternInput;
  }
  re2() {
    return this.re2Input;
  }
  /**
  * Matches a string against a regular expression.
  *
  * @param {string|number[]|Uint8Array} input the input
  * @returns {boolean} true if the regular expression matches the entire input
  */
  matches(input) {
    return this.testExact(input);
  }
  /**
  * Creates a new {@code Matcher} matching the pattern against the input.
  *
  * @param {string|number[]|Uint8Array|MatcherInputBase} input the input string
  * @returns {Matcher}
  */
  matcher(input) {
    if (Utils.isByteArray(input)) input = MatcherInput.utf8(input);
    return new Matcher(this, input);
  }
  /**
  * Tests whether the regular expression matches any part of the input string.
  * Performance Note: This method is highly optimized. Because it only returns
  * a boolean and does not extract capture groups, it bypasses the `Matcher` overhead
  * and guarantees execution on the high-speed DFA engine whenever possible.
  *
  * @param {string|number[]|Uint8Array} input - The input string or UTF-8 byte array to test against.
  * @returns {boolean} `true` if the pattern is found anywhere in the input, `false` otherwise.
  */
  test(input) {
    if (Utils.isByteArray(input)) return this.re2Input.matchUTF8(input);
    return this.re2Input.match(input);
  }
  /**
  * Tests whether the regular expression matches the ENTIRE input string.
  * * **Performance Note:** This operates identically to `.matches()`, but is significantly
  * faster because it does not request capture group data. By requesting 0 capture groups,
  * it securely routes execution through the DFA fast-path.
  *
  * @param {string|number[]|Uint8Array} input - The input string or UTF-8 byte array to test against.
  * @returns {boolean} `true` if the exact input string fully matches the pattern, `false` otherwise.
  */
  testExact(input) {
    const machineInput = Utils.isByteArray(input) ? MachineInput.fromUTF8(input) : MachineInput.fromUTF16(input);
    return this.re2Input.executeEngine(machineInput, 0, RE2Flags.ANCHOR_BOTH, 0) !== null;
  }
  /**
  * Executes a search for a match in a specified string.
  * Returns a result array, or null if no match is found.
  * The returned array perfectly mirrors standard JavaScript `RegExpExecArray`,
  * including `.index`, `.input`, and `.groups` properties.
  *
  * @param {string|number[]|Uint8Array} input the input string or byte array
  * @returns {Array|null} the match array with index, input, and groups properties, or null
  */
  exec(input) {
    const m = this.matcher(input);
    if (!m.find()) return null;
    const result = [m.group(0)];
    for (let i = 1; i <= m.groupCount(); i++) {
      const val = m.group(i);
      result.push(val === null ? void 0 : val);
    }
    result.index = m.start(0);
    result.input = input;
    const namedGroups = this.namedGroups();
    if (Object.keys(namedGroups).length > 0) {
      const parsedGroups = m.getNamedGroups();
      for (const key in parsedGroups) if (parsedGroups[key] === null) parsedGroups[key] = void 0;
      result.groups = parsedGroups;
    } else result.groups = void 0;
    return result;
  }
  /**
  * Splits input around instances of the regular expression. It returns an array giving the strings
  * that occur before, between, and after instances of the regular expression.
  *
  * If {@code limit <= 0}, there is no limit on the size of the returned array. If
  * {@code limit == 0}, empty strings that would occur at the end of the array are omitted. If
  * {@code limit > 0}, at most limit strings are returned. The final string contains the remainder
  * of the input, possibly including additional matches of the pattern.
  *
  * @param {string} input the input string to be split
  * @param {number} [limit=0] the limit
  * @returns {string[]} the split strings
  */
  split(input, limit = 0) {
    const m = this.matcher(input);
    const result = [];
    let emptiesSkipped = 0;
    let last = 0;
    while (m.find()) {
      if (last === 0 && m.end() === 0) {
        last = m.end();
        continue;
      }
      if (limit > 0 && result.length === limit - 1) break;
      if (last === m.start()) {
        if (limit === 0) {
          emptiesSkipped += 1;
          last = m.end();
          continue;
        }
      } else while (emptiesSkipped > 0) {
        result.push("");
        emptiesSkipped -= 1;
      }
      result.push(m.substring(last, m.start()));
      last = m.end();
    }
    if (limit === 0 && last !== m.inputLength()) {
      while (emptiesSkipped > 0) {
        result.push("");
        emptiesSkipped -= 1;
      }
      result.push(m.substring(last, m.inputLength()));
    }
    if (limit !== 0 || result.length === 0 && !(last === m.inputLength() && last > 0)) result.push(m.substring(last, m.inputLength()));
    return result;
  }
  /**
  * Returns an iterator of all results matching a string against the regular expression,
  * including capturing groups.
  *
  * @param {string|number[]|Uint8Array} input the input string or byte array
  * @returns {IterableIterator<RegExpMatchArray>}
  */
  *matchAll(input) {
    const m = this.matcher(input);
    while (m.find()) {
      const result = [m.group(0)];
      for (let i = 1; i <= m.groupCount(); i++) {
        const groupVal = m.group(i);
        result.push(groupVal === null ? void 0 : groupVal);
      }
      result.index = m.start(0);
      result.input = input;
      const namedGroups = this.namedGroups();
      if (Object.keys(namedGroups).length > 0) {
        const parsedGroups = m.getNamedGroups();
        for (const key in parsedGroups) if (parsedGroups[key] === null) parsedGroups[key] = void 0;
        result.groups = parsedGroups;
      } else result.groups = void 0;
      yield result;
    }
  }
  /**
  *
  * @returns {string}
  */
  toString() {
    return this.patternInput;
  }
  /**
  * Returns the program size of this pattern.
  *
  * <p>
  * Similar to the C++ implementation, the program size is a very approximate measure of a regexp's
  * "cost". Larger numbers are more expensive than smaller numbers.
  * </p>
  *
  * @returns {number} the program size of this pattern
  */
  programSize() {
    return this.re2Input.numberOfInstructions();
  }
  /**
  * Returns the number of capturing groups in this matcher's pattern. Group zero denotes the entire
  * pattern and is excluded from this count.
  *
  * @returns {number} the number of capturing groups in this pattern
  */
  groupCount() {
    return this.re2Input.numberOfCapturingGroups();
  }
  /**
  * Return a map of the capturing groups in this matcher's pattern, where key is the name and value
  * is the index of the group in the pattern.
  * @returns {Record<string, number>}
  */
  namedGroups() {
    return this.re2Input.namedGroups;
  }
  /**
  *
  * @param {*} other
  * @returns {boolean}
  */
  equals(other) {
    if (this === other) return true;
    if (other === null || this.constructor !== other.constructor) return false;
    return this.flagsInput === other.flagsInput && this.patternInput === other.patternInput;
  }
};

// ../schema/manifest.schema.json
var manifest_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:team-relay:manifest:1",
  title: "Capability manifest",
  description: "Named, parameterised operations a member will run for teammates. One file drives the plugin's install questions (userConfig), the capability enum the answering session exposes, and the discovery payload teammates see. Never free-form SQL, shell or paths: every parameter is an enum, a bounded number, a boolean, or a string with a length cap and an allow-list pattern.",
  type: "object",
  additionalProperties: false,
  required: ["version", "capabilities"],
  properties: {
    version: { const: 1 },
    capabilities: {
      type: "array",
      maxItems: 32,
      items: { $ref: "#/$defs/capability" }
    },
    shares: {
      description: "The folders the member's answering session may read for teammates, by basename only, never a full path (M4-SPEC \xA73). Optional; absent means the member shares nothing.",
      type: "array",
      maxItems: 16,
      uniqueItems: true,
      items: { $ref: "#/$defs/share" }
    }
  },
  $defs: {
    share: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" }
      }
    },
    identifier: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]{1,62}$"
    },
    capability: {
      type: "object",
      additionalProperties: false,
      required: ["name", "title", "description", "environment", "params"],
      properties: {
        name: { $ref: "#/$defs/identifier" },
        title: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", minLength: 1, maxLength: 500 },
        environment: {
          description: "production capabilities stay off unless the member opts in to production data at install, whatever default_enabled says.",
          enum: ["staging", "production"]
        },
        default_enabled: { type: "boolean", default: false },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 900, default: 120 },
        params: {
          type: "object",
          maxProperties: 16,
          propertyNames: { $ref: "#/$defs/identifier" },
          additionalProperties: { $ref: "#/$defs/param" }
        },
        required: {
          type: "array",
          uniqueItems: true,
          items: { $ref: "#/$defs/identifier" },
          default: []
        }
      }
    },
    param: {
      oneOf: [
        { $ref: "#/$defs/param_enum" },
        { $ref: "#/$defs/param_string" },
        { $ref: "#/$defs/param_integer" },
        { $ref: "#/$defs/param_number" },
        { $ref: "#/$defs/param_boolean" }
      ]
    },
    param_enum: {
      type: "object",
      additionalProperties: false,
      required: ["type", "values", "description"],
      properties: {
        type: { const: "enum" },
        description: { type: "string", minLength: 1, maxLength: 300 },
        values: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" }
        },
        default: { type: "string" }
      }
    },
    param_string: {
      description: "A bounded string that must match an allow-list pattern, anchored with ^ and $. There is no unconstrained string type.",
      type: "object",
      additionalProperties: false,
      required: ["type", "max_length", "pattern", "description"],
      properties: {
        type: { const: "string" },
        description: { type: "string", minLength: 1, maxLength: 300 },
        max_length: { type: "integer", minimum: 1, maximum: 500 },
        pattern: { type: "string", pattern: "^\\^.*\\$$", maxLength: 300 },
        default: { type: "string" }
      }
    },
    param_integer: {
      type: "object",
      additionalProperties: false,
      required: ["type", "min", "max", "description"],
      properties: {
        type: { const: "integer" },
        description: { type: "string", minLength: 1, maxLength: 300 },
        min: { type: "integer" },
        max: { type: "integer" },
        default: { type: "integer" }
      }
    },
    param_number: {
      type: "object",
      additionalProperties: false,
      required: ["type", "min", "max", "description"],
      properties: {
        type: { const: "number" },
        description: { type: "string", minLength: 1, maxLength: 300 },
        min: { type: "number" },
        max: { type: "number" },
        default: { type: "number" }
      }
    },
    param_boolean: {
      type: "object",
      additionalProperties: false,
      required: ["type", "description"],
      properties: {
        type: { const: "boolean" },
        description: { type: "string", minLength: 1, maxLength: 300 },
        default: { type: "boolean" }
      }
    }
  }
};

// src/manifest.ts
var ManifestError = class extends Error {
  problems;
  constructor(problems) {
    super(`invalid manifest: ${problems.join("; ")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
};
var MAX_PATTERN_LENGTH = 300;
var MAX_SAFE_MAGNITUDE = 2 ** 53;
var RESERVED_PARAM_NAMES = ["request_id"];
var Ajv2020 = import__.default.default ?? import__.default;
var compiled;
function schemaValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
    compiled = ajv.compile(manifest_schema_default);
  }
  return compiled;
}
function compilePattern(pattern) {
  return RE2JS.compile(pattern);
}
function fullMatch(re, value) {
  return re.matches(value);
}
var patternCache = /* @__PURE__ */ new Map();
function cachedPattern(pattern) {
  let re = patternCache.get(pattern);
  if (!re) {
    re = compilePattern(pattern);
    if (patternCache.size >= 256) patternCache.clear();
    patternCache.set(pattern, re);
  }
  return re;
}
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const next = value.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 56320 && c <= 57343) return true;
  }
  return false;
}
function isSafeMagnitude(v) {
  return Number.isFinite(v) && Math.abs(v) <= MAX_SAFE_MAGNITUDE;
}
function isAnchored(pattern) {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}
function codePointLength(value) {
  let n = 0;
  for (const _ of value) n++;
  return n;
}
function describeAjvErrors(errors) {
  const out = [];
  for (const e of errors) {
    const where = e.instancePath || "(root)";
    let msg = `${where}: ${e.message ?? "invalid"}`;
    if (e.keyword === "additionalProperties" && e.params && "additionalProperty" in e.params) {
      msg += ` (${String(e.params.additionalProperty)})`;
    }
    if (!out.includes(msg)) out.push(msg);
  }
  return out;
}
function checkParamDefault(capName, pname, p) {
  if (p.default === void 0) return null;
  const r = validateOne(pname, p, p.default);
  return r === null ? null : `${capName}.${pname}: default does not satisfy its own param (${r})`;
}
function validateManifest(doc) {
  const validate = schemaValidator();
  if (!validate(doc)) {
    throw new ManifestError(describeAjvErrors(validate.errors ?? []));
  }
  const manifest = doc;
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const cap of manifest.capabilities) {
    if (seen.has(cap.name)) problems.push(`duplicate capability name: ${cap.name}`);
    seen.add(cap.name);
    const required = new Set(cap.required ?? []);
    for (const [pname, p] of Object.entries(cap.params)) {
      if (RESERVED_PARAM_NAMES.includes(pname)) {
        problems.push(`${cap.name}.${pname}: ${pname} is a reserved name and may not be a param`);
        continue;
      }
      if (required.has(pname) && p.default !== void 0) {
        problems.push(`${cap.name}.${pname}: a required param may not declare a default`);
        continue;
      }
      if (p.type === "string") {
        const pattern = p.pattern;
        if (codePointLength(pattern) > MAX_PATTERN_LENGTH) {
          problems.push(`${cap.name}.${pname}: pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
          continue;
        }
        if (hasLoneSurrogate(pattern)) {
          problems.push(`${cap.name}.${pname}: pattern contains a lone surrogate`);
          continue;
        }
        if (!isAnchored(pattern)) {
          problems.push(`${cap.name}.${pname}: pattern must be anchored with ^ and $`);
          continue;
        }
        try {
          compilePattern(pattern);
        } catch (err) {
          problems.push(`${cap.name}.${pname}: pattern does not compile in RE2 (${err.message.slice(0, 200)})`);
          continue;
        }
      }
      if (p.type === "integer" || p.type === "number") {
        const bad = ["min", "max", "default"].find((k) => {
          const v = p[k];
          return v !== void 0 && !isSafeMagnitude(v);
        });
        if (bad) {
          problems.push(`${cap.name}.${pname}: ${bad} must be finite and within \xB12^53`);
          continue;
        }
        if (p.min > p.max) {
          problems.push(`${cap.name}.${pname}: min ${p.min} is greater than max ${p.max}`);
          continue;
        }
      }
      const d = checkParamDefault(cap.name, pname, p);
      if (d) problems.push(d);
    }
    for (const r of cap.required ?? []) {
      if (!Object.hasOwn(cap.params, r)) problems.push(`${cap.name}: required name ${r} is not a param`);
    }
  }
  if (problems.length > 0) throw new ManifestError(problems);
  return manifest;
}
function parseManifest(text) {
  let doc;
  try {
    doc = (0, import_yaml.parse)(text, { maxAliasCount: 50 });
  } catch (err) {
    throw new ManifestError([`not valid YAML: ${err.message}`]);
  }
  return validateManifest(doc);
}
function loadManifest(path) {
  return parseManifest(readFileSync(path, "utf8"));
}
function validateOne(name, p, v) {
  switch (p.type) {
    case "enum":
      if (typeof v !== "string") return `${name} must be a string`;
      if (!p.values.includes(v)) return `${name} must be one of ${p.values.join(", ")}`;
      return null;
    case "string": {
      if (typeof v !== "string") return `${name} must be a string`;
      if (hasLoneSurrogate(v)) return `${name} contains a lone surrogate`;
      if (codePointLength(v) > p.max_length) return `${name} is longer than ${p.max_length} characters`;
      let re;
      try {
        re = cachedPattern(p.pattern);
      } catch {
        return `${name} has a pattern that does not compile`;
      }
      if (!fullMatch(re, v)) return `${name} does not match its allowed pattern`;
      return null;
    }
    case "integer":
      if (typeof v !== "number" || !isSafeMagnitude(v) || !Number.isInteger(v)) return `${name} must be an integer`;
      if (v < p.min || v > p.max) return `${name} must be between ${p.min} and ${p.max}`;
      return null;
    case "number":
      if (typeof v !== "number" || !isSafeMagnitude(v)) return `${name} must be a finite number within \xB12^53`;
      if (v < p.min || v > p.max) return `${name} must be between ${p.min} and ${p.max}`;
      return null;
    case "boolean":
      if (typeof v !== "boolean") return `${name} must be true or false`;
      return null;
    default:
      return `${name} has an unknown type`;
  }
}

// src/exposed.ts
function defaultManifestPath() {
  return fileURLToPath(new URL("../manifest.yaml", import.meta.url));
}

// src/console-demo.ts
var DEMO_TEAM = "demo";
var DEMO_ME = "alice";
var DEMO_MEMBERS = ["alice", "bob", "carol"];
var DEMO_CYCLE_MS = 6e4;
var WARMUP_CYCLES = 10;
var DAY_MS = 864e5;
var DEMO_TTL_MS = 36e5;
var PREVIEW_CHARS = 2e3;
var SWEEP_LAG_MS = 2e3;
var STATS_READ_CAP = 500;
var ACTIVITY_MAX_GROUP = 500;
var QUESTIONS_TO_BOB = [
  "Which service owns the nightly invoice export, and where is its retry policy configured?",
  "Is the orders table still partitioned by month in staging, or did that change with the last migration?",
  "What is the current timeout for calls from the web app to the pricing service?"
];
var ANSWERS_FROM_BOB = [
  "The invoice export lives in the worker service (jobs/export_invoices). Retries are set in its job config: three attempts, exponential backoff starting at 30 s.",
  "Still monthly. The last migration only added an index on status; partitioning is unchanged.",
  "Eight seconds, set in the web app client config, with one retry on a connection error only."
];
var SECOND_FACTS = [
  "Does anyone know whether the feature flag for the new checkout is on in staging?",
  "Who changed the staging rate limits this week, and why?",
  "Is there a runbook for rotating the staging database password?"
];
function scripts(cycle) {
  const v = cycle % 3;
  return [
    {
      offset: 0,
      kind: "question",
      asker: "alice",
      to: ["bob"],
      broadcast: false,
      question: QUESTIONS_TO_BOB[v],
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: "bob", do: "deliver" },
        { at: 2500, to: "bob", do: "ack" },
        { at: 4e3, to: "bob", do: "tool", tool: "Grep", status: "ok", duration_ms: 31 + v * 7 },
        // A file outside bob's shared folders: his session waits for him to allow it.
        { at: 5200, to: "bob", do: "waiting", tool: "Read" },
        { at: 16e3, to: "bob", do: "tool", tool: "Read", status: "ok", duration_ms: 12 + v * 3 },
        { at: 2e4, to: "bob", do: "answer", text: ANSWERS_FROM_BOB[v] },
        { at: 21100, to: "bob", do: "answer_delivered" }
      ]
    },
    {
      offset: 6e3,
      kind: "capability",
      asker: "alice",
      to: ["bob"],
      broadcast: false,
      capability: {
        name: "staging_db_query",
        params: { dataset: "orders", field: "status", op: "eq", value: ["pending", "failed", "shipped"][v], limit: 20 }
      },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 900, to: "bob", do: "deliver" },
        { at: 2800, to: "bob", do: "ack" },
        { at: 4e3, to: "bob", do: "progress", text: "connecting to the staging database", pct: 10 },
        { at: 6200, to: "bob", do: "progress", text: "reading rows", pct: 60 },
        { at: 8500, to: "bob", do: "tool", tool: "staging_db_query", status: "ok", duration_ms: 4100 + v * 250 },
        { at: 11e3, to: "bob", do: "answer", text: `Found ${3 + v} orders with that status in staging; rows are in the data.` },
        { at: 12e3, to: "bob", do: "answer_delivered" }
      ]
    },
    {
      offset: 15e3,
      kind: "question",
      asker: "bob",
      to: ["alice", "carol"],
      broadcast: true,
      question: "Is anyone else seeing slow builds on the shared runner this afternoon?",
      ackTimeout: 20,
      answerTimeout: 600,
      steps: [
        { at: 1e3, to: "alice", do: "deliver" },
        { at: 1600, to: "carol", do: "deliver" },
        { at: 3e3, to: "alice", do: "ack" },
        { at: 4500, to: "alice", do: "tool", tool: "Read", status: "ok", duration_ms: 9 },
        { at: 1e4, to: "alice", do: "answer", text: "Yes, since about two o'clock: the cache volume is nearly full, so every build restores from scratch." },
        { at: 11e3, to: "alice", do: "answer_delivered" }
      ]
    },
    {
      offset: 25e3,
      kind: "question",
      asker: "carol",
      to: ["bob"],
      broadcast: false,
      question: SECOND_FACTS[v],
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 700, to: "bob", do: "deliver" },
        { at: 2e3, to: "bob", do: "ack" },
        { at: 3300, to: "bob", do: "tool", tool: "Glob", status: "ok", duration_ms: 18 },
        { at: 4100, to: "bob", do: "tool", tool: "Read", status: "error", duration_ms: 4 },
        { at: 5e3, to: "bob", do: "tool", tool: "Read", status: "ok", duration_ms: 11 },
        { at: 12e3, to: "bob", do: "answer", text: "Yes; details are in the team notes under staging." },
        { at: 13e3, to: "bob", do: "answer_delivered" }
      ]
    },
    {
      offset: 32e3,
      kind: "question",
      asker: "alice",
      to: ["carol"],
      broadcast: false,
      question: "Can you check why the staging data refresh did not run last night?",
      ackTimeout: 10,
      answerTimeout: 25,
      steps: [
        { at: 900, to: "carol", do: "deliver" },
        { at: 2400, to: "carol", do: "ack" },
        { at: 4e3, to: "carol", do: "tool", tool: "Grep", status: "ok", duration_ms: 44 },
        { at: 6500, to: "carol", do: "tool", tool: "Read", status: "ok", duration_ms: 15 }
      ]
    },
    {
      offset: 4e4,
      kind: "capability",
      asker: "bob",
      to: ["carol"],
      broadcast: false,
      capability: { name: "service_health", params: { service: ["worker", "api", "web"][v] } },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: "carol", do: "deliver" },
        { at: 2e3, to: "carol", do: "ack" },
        { at: 3e3, to: "carol", do: "progress", text: "calling the health endpoint", pct: 50 },
        { at: 4800, to: "carol", do: "tool", tool: "service_health", status: "ok", duration_ms: 1800 },
        { at: 7e3, to: "carol", do: "answer", text: "Healthy, no errors in the last hour." },
        { at: 8e3, to: "carol", do: "answer_delivered" }
      ]
    },
    {
      // Created as carol's answer above is returned (40 s + 8 s): the same updated_at.
      offset: 48e3,
      kind: "question",
      asker: "carol",
      to: ["alice", "bob"],
      broadcast: true,
      question: "Which of you knows how the staging cache is warmed after a deploy?",
      ackTimeout: 60,
      answerTimeout: 600,
      steps: [
        // Delivered to both in the same millisecond: two changes, the second stamped 1 ms on.
        { at: 800, to: "alice", do: "deliver" },
        { at: 800, to: "bob", do: "deliver" },
        { at: 2e3, to: "bob", do: "ack" },
        { at: 2600, to: "alice", do: "ack" },
        { at: 3500, to: "alice", do: "tool", tool: "Grep", status: "ok", duration_ms: 27 },
        { at: 6e3, to: "bob", do: "answer", text: "A post-deploy job requests the ten busiest pages once each." },
        { at: 6800, to: "bob", do: "answer_delivered" },
        { at: 8e3, to: "alice", do: "answer", text: "The deploy pipeline runs a warm-up step; the page list is in its config." },
        { at: 9e3, to: "alice", do: "answer_delivered" }
      ]
    }
  ];
}
var iso = (ms) => new Date(ms).toISOString();
function requestId(epoch2, cycle, index) {
  return `rq_${createHash("sha256").update(`team-relay-demo:${epoch2}:${cycle}:${index}`).digest("hex").slice(0, 32)}`;
}
function materialise(s, created, id, now, environments) {
  if (created > now) return null;
  const recipients = {};
  for (const m of s.to) {
    recipients[m] = {
      status: "pending",
      delivered_at: null,
      acked_at: null,
      answered_at: null,
      answer_delivered_at: null,
      tools: [],
      progress_count: 0,
      last_progress_pct: null,
      answer_preview: null
    };
  }
  const progress = [];
  const answers = {};
  let updated = created;
  const ackDeadline = created + s.ackTimeout * 1e3;
  const answerDeadline = created + s.answerTimeout * 1e3;
  const events = s.steps.map((step) => ({
    at: created + step.at,
    apply: () => {
      const r = recipients[step.to];
      const t = iso(created + step.at);
      switch (step.do) {
        case "deliver":
          r.delivered_at ??= t;
          break;
        case "ack":
          if (r.status === "pending" || r.status === "no_response") r.status = "acked";
          r.acked_at ??= t;
          break;
        case "tool":
          r.tools.push({ tool: step.tool, status: step.status, at: t, duration_ms: step.duration_ms });
          progress.push({ seq: progress.length + 1, member: step.to, kind: "tool", tool: step.tool, status: step.status, duration_ms: step.duration_ms, time: t });
          break;
        case "waiting":
          r.tools.push({ tool: step.tool, status: "waiting", at: t, duration_ms: null });
          progress.push({ seq: progress.length + 1, member: step.to, kind: "tool", tool: step.tool, status: "waiting", duration_ms: null, time: t });
          break;
        case "progress":
          r.progress_count++;
          r.last_progress_pct = step.pct;
          progress.push({ seq: progress.length + 1, member: step.to, kind: "progress", text: step.text, pct: step.pct, time: t });
          break;
        case "answer":
          r.status = "answered";
          r.acked_at ??= t;
          r.answered_at = t;
          r.answer_preview = step.text.slice(0, PREVIEW_CHARS);
          answers[step.to] = step.text;
          break;
        case "answer_delivered":
          r.answer_delivered_at ??= t;
          break;
      }
    }
  }));
  for (const m of s.to) {
    events.push({ at: ackDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m].status === "pending" && (recipients[m].status = "no_response")) });
    events.push({ at: answerDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m].status === "acked" && (recipients[m].status = "timed_out")) });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.at > now) break;
    const before = JSON.stringify(recipients);
    e.apply();
    if (JSON.stringify(recipients) !== before) updated = Math.max(e.at, updated + 1);
  }
  const doc = {
    request_id: id,
    kind: s.kind,
    asker: s.asker,
    broadcast: s.broadcast,
    created_at: iso(created),
    updated_at: iso(updated),
    ack_deadline: iso(ackDeadline),
    answer_deadline: iso(answerDeadline),
    expire_at: iso(created + DEMO_TTL_MS),
    capability: s.capability ? { name: s.capability.name, environment: environments.get(s.capability.name) ?? "staging", params: { ...s.capability.params } } : null,
    question: s.question ?? null,
    recipients,
    participant: true
  };
  return { doc, progress, answers };
}
function viewFor(doc, viewer) {
  const isAsker = doc.asker === viewer;
  const participant = isAsker || Object.hasOwn(doc.recipients, viewer);
  const recipients = {};
  for (const [m, r] of Object.entries(doc.recipients)) {
    recipients[m] = { ...r, answer_preview: isAsker || m === viewer ? r.answer_preview : null };
  }
  return {
    ...doc,
    question: participant ? doc.question : null,
    capability: doc.capability ? { ...doc.capability, params: participant ? doc.capability.params : null } : null,
    recipients,
    participant
  };
}
function stillOpen(doc, r, now) {
  if (r.status === "pending") return now < Date.parse(doc.ack_deadline);
  if (r.status === "acked") return now < Date.parse(doc.answer_deadline);
  return false;
}
function median3(values) {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(m * 1e3) / 1e3;
}
function memberStats(docs, member, start, now) {
  let asked = 0;
  let answered = 0;
  let open = 0;
  const seconds = [];
  for (const d of docs) {
    if (d.asker === member && Date.parse(d.created_at) >= start) asked++;
    const r = d.recipients[member];
    if (!r) continue;
    if (r.answered_at !== null && Date.parse(r.answered_at) >= start) {
      answered++;
      seconds.push((Date.parse(r.answered_at) - Date.parse(d.created_at)) / 1e3);
    }
    if (stillOpen(d, r, now)) open++;
  }
  return { asked, answered, open, median_answer_seconds: median3(seconds) };
}
var NotFound = class extends Error {
  constructor() {
    super("not_found");
    this.name = "NotFound";
  }
};
var RosterRefusal = class extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "RosterRefusal";
  }
  status;
  code;
  detail;
};
var DEMO_BOUNDARIES = {
  topic: "Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.",
  github_orgs: ["example-org"],
  drives: [{ domain: "example.com", shared_drive: "Example Team Drive" }],
  member_folders: true
};
var ROSTER_MAX = 50;
var DEMO_REPLIES = {
  bob: {
    ack: 1500,
    at: 6e3,
    text: "From the orders-service repository: the export job is jobs/export_invoices, and its retries are set in config/jobs.yaml (three attempts, backoff from 30 s).\n\nI read README.md and config/jobs.yaml to answer."
  },
  carol: {
    ack: 2500,
    at: 14e3,
    text: "I could not find that in what I answer from. bob owns the worker service; he will know."
  }
};
var ASKED_MAX = 200;
var BadRequest = class extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
    this.name = "BadRequest";
  }
  detail;
};
var DemoTeam = class {
  constructor(now = Date.now, manifestPath = defaultManifestPath(), options = {}) {
    this.now = now;
    this.team = options.team ?? DEMO_TEAM;
    this.name = options.name ?? "Demo";
    this.quiet = options.roster !== void 0;
    this.viewer = options.viewer ?? DEMO_ME;
    const start = now();
    this.epoch = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS - WARMUP_CYCLES * DEMO_CYCLE_MS;
    const manifest = loadManifest(manifestPath);
    const pick = (names) => ({
      version: 1,
      capabilities: manifest.capabilities.filter((c) => names.includes(c.name))
    });
    for (const c of manifest.capabilities) this.environments.set(c.name, c.environment);
    this.manifests = {
      alice: null,
      bob: { ...pick(["staging_db_query"]), shares: [{ name: "orders-service" }, { name: "runbooks" }] },
      carol: { ...pick(["service_health", "production_db_count"]), shares: [] }
    };
    this.publishedAt = iso(this.epoch - 36e5);
    const added = iso(this.epoch - 7 * DAY_MS);
    this.rosterEntries = options.roster ? options.roster.map((e) => ({ ...e, emails: [...e.emails] })) : [
      { member: "alice", emails: ["alice@example.com"], role: "owner", added_by: "alice", added_at: added, status: "active" },
      { member: "bob", emails: ["bob@example.com"], role: "member", added_by: "alice", added_at: added, status: "active" },
      { member: "carol", emails: ["carol@example.com", "carol.w@example.org"], role: "member", added_by: "alice", added_at: added, status: "active" },
      // M9-SPEC §7.2: an invitation dana has not answered yet.
      { member: "dana", emails: ["dana@example.com"], role: "member", added_by: "alice", added_at: iso(this.epoch - DAY_MS), status: "invited" }
    ];
    const set = options.roster === void 0 ? { boundaries: DEMO_BOUNDARIES, version: 2, updated_by: DEMO_ME } : options.boundaries;
    this.bounds = set ? {
      team: this.team,
      version: set.version,
      boundaries: structuredClone(set.boundaries),
      since: nextSince(null, 1, set.boundaries),
      updated_at: iso(this.epoch - 2 * DAY_MS),
      updated_by: set.updated_by
    } : { team: this.team, version: 0, boundaries: null, since: null, updated_at: null, updated_by: null };
    this.accepted = options.roster === void 0 ? { version: 1, accepted_at: iso(this.epoch - 3 * DAY_MS) } : { version: 0, accepted_at: null };
  }
  now;
  team;
  name;
  /** No scripted traffic: a team created (or joined) in the demo. */
  quiet;
  viewer;
  epoch;
  manifests;
  environments = /* @__PURE__ */ new Map();
  publishedAt;
  /** M6-SPEC §1, in memory: alice owns the demo team; bob and carol are members. */
  rosterEntries;
  /** M10-SPEC §1, in memory. */
  bounds;
  /** M11-SPEC §2, in memory: the boundaries version the viewer accepted (0: never). */
  accepted;
  /** M11-SPEC §4, in memory: questions the viewer asked from the console, oldest first. */
  asked = [];
  /** GET /v1/teams/{team}/me/acceptance (M11-SPEC §2): the viewer's own. Never accepted: 0. */
  acceptance() {
    return { ...this.accepted };
  }
  /**
   * PUT /v1/teams/{team}/me/acceptance (M11-SPEC §2): the viewer accepts, for themselves, the
   * version they were shown; it must be the current one.
   */
  setAcceptance(version) {
    if (this.bounds.boundaries === null) throw new RosterRefusal(409, "not_set", "The team has no boundaries to accept yet.");
    if (version !== this.bounds.version) {
      throw new RosterRefusal(409, "version_conflict", "The boundaries changed since you read them. Read them again.");
    }
    this.accepted = { version, accepted_at: iso(this.now()) };
    return this.acceptance();
  }
  /**
   * GET /v1/teams/{team}/members/status (M11-SPEC §3): each active member's last status (counts
   * and booleans only), whether they answered within 180 s, and the version they accepted.
   */
  membersStatus() {
    const now = this.now();
    const active = this.rosterEntries.filter((e) => e.status === "active").map((e) => e.member);
    const status = (o) => ({
      daemon: { version: "0.11.0", started_at: iso(now - 5 * 36e5) },
      claude: { found: true, signed_in: o.signedIn ?? true },
      folders: { repo_roots: o.roots ?? 1, clones: o.clones ?? 7, extra_folders: 0 },
      drive: { connected: o.drive ?? true },
      self_test: { ok: o.selfOk ?? true, at: iso(now - 2 * 36e5), reason: o.reason ?? null },
      seen_at: iso(now - o.seenAgo)
    });
    const entry = (member) => {
      const accepted = member === this.viewer ? this.accepted.version : 0;
      if (this.quiet) return { member, status: null, answering: false, accepted_version: accepted };
      const s = member === "bob" ? status({ seenAgo: 25e3 }) : member === "carol" ? status({ signedIn: false, roots: 0, clones: 0, selfOk: false, reason: "Claude Code is not signed in.", seenAgo: 9 * 6e4 }) : status({ drive: false, seenAgo: 4e4 });
      const version = member === "bob" ? this.bounds.version : accepted;
      return { member, status: s, answering: now - Date.parse(s.seen_at) < 18e4, accepted_version: version };
    };
    return { members: active.map(entry), boundaries_version: this.bounds.version };
  }
  /** GET /v1/teams/{team}/me/requests (M11-SPEC §4): the viewer's own questions, newest first. */
  myRequests(limit) {
    const askedIds = new Set(this.asked.map((a) => a.id));
    const mine = this.all(this.now()).map((m) => m.doc).filter((d) => d.asker === this.viewer && d.kind === "question").sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(askedIds.has(b.request_id)) - Number(askedIds.has(a.request_id)) || b.request_id.localeCompare(a.request_id)
    );
    return {
      requests: mine.slice(0, limit).map((d) => ({
        id: d.request_id,
        to: d.broadcast ? "*" : Object.keys(d.recipients),
        created_at: d.created_at,
        question_preview: [...d.question ?? ""].slice(0, 200).join("")
      }))
    };
  }
  /**
   * POST /v1/teams/{team}/requests as a question from the viewer (M11-SPEC §4), with the relay's
   * refusals. On `demo`, bob answers after 6 s and carol after 14 s; nobody answers on a quiet team.
   */
  ask(body) {
    const teammates = this.me().teammates;
    let to;
    if (body.to === "*") {
      to = [...teammates].sort();
      if (to.length === 0) throw new RosterRefusal(400, "bad_recipients", "You have no teammates to broadcast to.");
    } else {
      if (body.to.includes(this.viewer)) throw new RosterRefusal(400, "bad_recipients", "You cannot send a request to yourself.");
      if (body.to.some((m) => !teammates.includes(m))) throw new RosterRefusal(400, "bad_recipients", "'to' names someone who is not in your team.");
      to = [...body.to];
    }
    const created = this.now();
    const id = `rq_${createHash("sha256").update(`team-relay-demo-ask:${this.team}:${this.epoch}:${this.asked.length}:${created}`).digest("hex").slice(0, 32)}`;
    const steps = [];
    if (!this.quiet) {
      for (const m of to) {
        const reply = DEMO_REPLIES[m];
        if (!reply) continue;
        steps.push({ at: reply.ack - 900, to: m, do: "deliver" }, { at: reply.ack, to: m, do: "ack" }, { at: reply.at, to: m, do: "answer", text: reply.text });
      }
    }
    const script = { offset: 0, kind: "question", asker: this.viewer, to, broadcast: body.to === "*", question: body.question, ackTimeout: 120, answerTimeout: 1800, steps };
    this.asked.push({ id, created, script });
    if (this.asked.length > ASKED_MAX) this.asked.shift();
    return {
      request_id: id,
      recipients: to,
      created: true,
      ack_deadline: iso(created + 12e4),
      answer_deadline: iso(created + 18e5),
      expire_at: iso(created + DEMO_TTL_MS)
    };
  }
  /** GET /v1/teams/{team}/boundaries (M10-SPEC §1): any member. Never set: version 0, null. */
  boundaries() {
    return structuredClone(this.bounds);
  }
  /** PUT /v1/teams/{team}/boundaries (M10-SPEC §1): owners, at the current version. */
  setBoundaries(body) {
    if (this.viewerRole() !== "owner") throw new RosterRefusal(403, "forbidden", "Only team owners can set the boundaries.");
    if (body.version !== this.bounds.version) {
      throw new RosterRefusal(409, "version_conflict", "The boundaries changed since you read them. Read them again.");
    }
    const version = this.bounds.version + 1;
    this.bounds = {
      team: this.team,
      version,
      boundaries: structuredClone(body.boundaries),
      since: nextSince(this.bounds, version, body.boundaries),
      updated_at: iso(this.now()),
      updated_by: this.viewer
    };
    return this.boundaries();
  }
  /** The viewer's role here, by the roster's active entries. */
  viewerRole() {
    return this.rosterEntries.find((e) => e.member === this.viewer && e.status === "active")?.role ?? "member";
  }
  /** Active members and owners, as the admin listing counts them. */
  counts() {
    const active = this.rosterEntries.filter((e) => e.status === "active");
    return { members: active.length, owners: active.filter((e) => e.role === "owner").length };
  }
  requireOwner() {
    if (this.viewerRole() !== "owner") throw new RosterRefusal(403, "forbidden", "Only owners can change the roster.");
  }
  /**
   * M6-SPEC §2 as alice (an owner) reads it: every member with emails and role. The demo keeps
   * changes in memory, under the relay's invariants (§1): unique ids and emails, at most 50
   * members, 1 to 5 emails each, and always at least one owner.
   */
  roster() {
    const owner = this.viewerRole() === "owner";
    return {
      members: this.rosterEntries.filter((e) => owner || e.status === "active").map((e) => ({
        member: e.member,
        emails: owner || e.member === this.viewer ? [...e.emails] : e.emails.map(() => null),
        role: e.role,
        added_by: e.added_by,
        added_at: e.added_at,
        status: e.status
      }))
    };
  }
  entry(member) {
    const e = this.rosterEntries.find((x) => x.member === member);
    if (!e) throw new NotFound();
    return e;
  }
  emailTaken(email2, except) {
    return this.rosterEntries.some((e) => e !== except && e.emails.includes(email2));
  }
  addMember(body) {
    this.requireOwner();
    if (this.rosterEntries.some((e) => e.member === body.member)) throw new RosterRefusal(409, "member_exists", "That member id is already on the team.");
    if (this.emailTaken(body.email)) throw new RosterRefusal(409, "email_taken", "That email already belongs to a member of the team.");
    if (this.rosterEntries.length >= ROSTER_MAX) throw new RosterRefusal(409, "team_full", `A team has at most ${ROSTER_MAX} members, invitations included.`);
    const entry = {
      member: body.member,
      emails: [body.email],
      role: body.role ?? "member",
      added_by: this.viewer,
      added_at: iso(this.now()),
      status: "invited"
    };
    this.rosterEntries.push(entry);
    return { ...entry, emails: [...entry.emails] };
  }
  updateMember(member, body) {
    this.requireOwner();
    const e = this.entry(member);
    const emails = [...e.emails];
    if (body.add_email !== void 0) {
      if (this.emailTaken(body.add_email, e) || emails.includes(body.add_email)) throw new RosterRefusal(409, "conflict", "That email already belongs to a member of the team.");
      if (emails.length >= 5) throw new RosterRefusal(409, "too_many_emails", "A member has at most 5 emails.");
      emails.push(body.add_email);
    }
    if (body.remove_email !== void 0) {
      if (!emails.includes(body.remove_email)) throw new RosterRefusal(404, "not_found", "That email is not one of theirs.");
      if (emails.length === 1) throw new RosterRefusal(409, "last_email", "A member needs at least one email.");
      emails.splice(emails.indexOf(body.remove_email), 1);
    }
    if (body.role === "member" && e.role === "owner" && e.status === "active" && this.activeOwners() === 1) {
      throw new RosterRefusal(409, "last_owner", "A team always has at least one owner.");
    }
    e.emails = emails;
    if (body.role !== void 0) e.role = body.role;
    return { member: e.member, emails: [...e.emails], role: e.role, added_by: e.added_by, added_at: e.added_at, status: e.status };
  }
  activeOwners() {
    return this.rosterEntries.filter((x) => x.role === "owner" && x.status === "active").length;
  }
  /** Remove a member, or withdraw an invitation (which retires nothing, M9-SPEC §7.2). */
  removeMember(member) {
    this.requireOwner();
    const e = this.entry(member);
    if (e.role === "owner" && e.status === "active" && this.activeOwners() === 1) {
      throw new RosterRefusal(409, "last_owner", "A team always has at least one owner.");
    }
    this.rosterEntries.splice(this.rosterEntries.indexOf(e), 1);
    return { member, removed: true };
  }
  /** Every request created by `now`; expired ones only when asked for (the feed passes them). */
  all(now, withExpired = false) {
    const out = [];
    for (const a of this.asked) {
      const m = materialise(a.script, a.created, a.id, now, this.environments);
      if (m && (withExpired || Date.parse(m.doc.expire_at) > now)) out.push(m);
    }
    if (this.quiet) return out;
    const first = Math.max(0, Math.floor((now - DEMO_TTL_MS - this.epoch) / DEMO_CYCLE_MS) - 1);
    const last = Math.floor((now - this.epoch) / DEMO_CYCLE_MS);
    for (let c = first; c <= last; c++) {
      const cycleStart = this.epoch + c * DEMO_CYCLE_MS;
      scripts(c).forEach((s, i) => {
        const m = materialise(s, cycleStart + s.offset, requestId(this.epoch, c, i), now, this.environments);
        if (m && (withExpired || Date.parse(m.doc.expire_at) > now)) out.push(m);
      });
    }
    return out;
  }
  me() {
    const teammates = this.quiet ? this.rosterEntries.filter((e) => e.status === "active" && e.member !== this.viewer).map((e) => e.member) : DEMO_MEMBERS.filter((m) => m !== DEMO_ME);
    return { team: this.team, name: this.name, member: this.viewer, role: this.viewerRole(), teammates };
  }
  presence(member, now) {
    const tick = (offset) => iso(Math.floor((now - offset) / 15e3) * 15e3);
    const cycleStart = this.epoch + Math.floor((now - this.epoch) / DEMO_CYCLE_MS) * DEMO_CYCLE_MS;
    switch (member) {
      case "bob":
        return { working: tick(2e3), answering: tick(1e3) };
      case "carol":
        return { working: iso(cycleStart + 3e3), answering: tick(4e3) };
      default:
        return { working: tick(0), answering: tick(500) };
    }
  }
  /**
   * M7-SPEC §1 as alice reads it. Her answering session polls through the demo, so it takes
   * what arrives at once and nothing waits.
   */
  inboxSummary() {
    if (this.quiet) return { pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: null } };
    const p = this.presence(DEMO_ME, this.now());
    return { pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: p.answering } };
  }
  /**
   * M2-SPEC §3.1, §3.6 as the relay computes them: one read of the most recently updated
   * requests of the last 24 h (at most STATS_READ_CAP, `stats_complete` false when the cap was
   * reached), expired ones left out; `asked` by creation in the window, `answered` and the
   * median by `answered_at` in the window, `open` by effective status (§7.2).
   */
  directory() {
    const now = this.now();
    const start = now - DAY_MS;
    const read = this.all(now).map((m) => m.doc).filter((d) => Date.parse(d.updated_at) > start).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.request_id.localeCompare(a.request_id)).slice(0, STATS_READ_CAP);
    if (this.quiet) {
      const members2 = this.me().teammates.map((member) => ({
        member,
        last_seen: null,
        manifest: null,
        published_at: null,
        sessions: { working: { last_seen: null }, answering: { last_seen: null } },
        stats: { asked: 0, answered: 0, open: 0, median_answer_seconds: null },
        inbox_waiting: 0
      }));
      return { members: members2, stats_complete: true };
    }
    const members = DEMO_MEMBERS.filter((m) => m !== DEMO_ME).map((member) => {
      const p = this.presence(member, now);
      const seen = [p.working, p.answering].filter((x) => x !== null).sort();
      const manifest = this.manifests[member];
      return {
        member,
        last_seen: seen.at(-1) ?? null,
        manifest,
        published_at: manifest ? this.publishedAt : null,
        sessions: { working: { last_seen: p.working }, answering: { last_seen: p.answering } },
        stats: memberStats(read, member, start, now),
        // M7-SPEC §1: every demo answering session is polling, so nothing waits.
        inbox_waiting: 0
      };
    });
    return { members, stats_complete: read.length < STATS_READ_CAP };
  }
  /**
   * M2-SPEC §3.5 with §7.10: ascending by updated_at, since-exclusive, at most `limit`, except
   * that a page never splits the requests sharing one updated_at: it is cut before such a
   * group, or, when the whole page is one group, returns all of it (up to 500). `next_since`
   * is the updated_at of the last request read, expired or not; expired ones are not returned.
   */
  activity(q = {}) {
    const now = this.now();
    let since;
    if (q.since === void 0) since = now - DAY_MS;
    else {
      since = Date.parse(q.since);
      if (!Number.isFinite(since)) throw new BadRequest("since must be an RFC 3339 time");
    }
    const limit = q.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequest("limit must be 1..200");
    const read = this.all(now, true).map((m) => m.doc).filter((d) => Date.parse(d.updated_at) > since).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.request_id.localeCompare(b.request_id));
    let page = read.slice(0, limit);
    if (read.length > limit && read[limit].updated_at === page.at(-1).updated_at) {
      const boundary = page.at(-1).updated_at;
      const before = page.filter((d) => d.updated_at !== boundary);
      page = before.length > 0 ? before : read.filter((d) => d.updated_at === boundary).slice(0, ACTIVITY_MAX_GROUP);
    }
    return {
      requests: page.filter((d) => Date.parse(d.expire_at) > now).map((d) => viewFor(d, DEMO_ME)),
      next_since: page.length > 0 ? page.at(-1).updated_at : iso(since),
      server_time: iso(now)
    };
  }
  /**
   * M1-SPEC §3.11 as alice, in the relay's shape: the asker sees every recipient, a recipient
   * only itself; progress holds progress and tool events in one shape (M2-SPEC §3.3), the
   * fields that do not apply to a kind being null.
   */
  request(id) {
    const now = this.now();
    const found = this.all(now).find((m) => m.doc.request_id === id);
    if (!found) throw new NotFound();
    const { doc, progress, answers } = found;
    const isAsker = doc.asker === this.viewer;
    if (!isAsker && !doc.recipients[this.viewer]) throw new NotFound();
    const recipients = {};
    for (const [m, r] of Object.entries(doc.recipients)) {
      if (isAsker) recipients[m] = { status: r.status, acked_at: r.acked_at, answered_at: r.answered_at, answer_preview: r.answer_preview, answer: answers[m] ?? null };
      else if (m === this.viewer) recipients[m] = { status: r.status, acked_at: r.acked_at, answered_at: r.answered_at };
    }
    return {
      request_id: doc.request_id,
      kind: doc.kind,
      asker: doc.asker,
      broadcast: doc.broadcast,
      question: doc.question,
      capability: doc.capability,
      created_at: doc.created_at,
      ack_deadline: doc.ack_deadline,
      answer_deadline: doc.answer_deadline,
      expire_at: doc.expire_at,
      recipients,
      progress: progress.filter((p) => isAsker || p.member === this.viewer).map(
        (p) => p.kind === "progress" ? { seq: p.seq, member: p.member, kind: p.kind, text: p.text, pct: p.pct, tool: null, status: null, duration_ms: null, time: p.time } : { seq: p.seq, member: p.member, kind: p.kind, text: null, pct: null, tool: p.tool, status: p.status, duration_ms: p.duration_ms, time: p.time }
      )
    };
  }
};
var DEMO_MAX_TEAMS_CREATED = 3;
var RESERVED_TEAM_IDS = /* @__PURE__ */ new Set(["admin", "api", "login", "v1", "health", "static", "www", "team", "teams", "relay", "console", "demo", "test"]);
var NEW_TEAM_ID = /^[a-z][a-z0-9-]{2,31}$/;
var RESERVE_MS = 31 * DAY_MS;
function teamIdFromName(name) {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(id)) id = `team-${id}`;
  id = id.slice(0, 32).replace(/-+$/, "");
  return id.length >= 3 ? id : `${id}-team`.slice(0, 32);
}
var DemoAccount = class {
  constructor(now = Date.now, manifestPath = defaultManifestPath()) {
    this.now = now;
    this.manifestPath = manifestPath;
    const t = now();
    const at = (daysAgo) => iso(t - daysAgo * DAY_MS);
    const entry = (member, role2, status, by, daysAgo) => ({
      member,
      emails: [`${member}@example.com`],
      role: role2,
      added_by: by,
      added_at: at(daysAgo),
      status
    });
    this.held.set(DEMO_TEAM, new DemoTeam(now, manifestPath));
    this.world.set(DEMO_TEAM, { id: DEMO_TEAM, name: "Demo", seed: true, status: "active", created_at: at(30), created_by_member: null, members: 0, owners: 0, last_activity_at: null });
    this.held.set(
      "research",
      new DemoTeam(now, manifestPath, {
        team: "research",
        name: "Research",
        roster: [entry("alice", "owner", "active", "alice", 5), entry("erin", "member", "active", "alice", 4), entry("frank", "member", "invited", "alice", 1)]
      })
    );
    this.createdByMe.add("research");
    this.world.set("research", { id: "research", name: "Research", seed: false, status: "active", created_at: at(5), created_by_member: "alice", members: 0, owners: 0, last_activity_at: at(1) });
    this.invitations = [
      {
        team: "ops",
        name: "Operations",
        member: "alice",
        role: "member",
        invited_by_member: "olga",
        roster: [entry("olga", "owner", "active", "olga", 12), entry("pat", "member", "active", "olga", 9), entry("alice", "member", "active", "olga", 0)],
        boundaries: {
          boundaries: {
            topic: "Operations at Example Co: on-call, incidents, infrastructure and the runbooks behind them.",
            github_orgs: ["example-ops"],
            drives: [{ domain: "example.com", shared_drive: "Operations" }],
            member_folders: false
          },
          version: 1,
          updated_by: "olga"
        }
      }
    ];
    this.world.set("ops", { id: "ops", name: "Operations", seed: false, status: "active", created_at: at(12), created_by_member: "olga", members: 2, owners: 1, last_activity_at: at(0.2) });
    this.world.set("design-guild", { id: "design-guild", name: "Design guild", seed: false, status: "active", created_at: at(20), created_by_member: "hana", members: 4, owners: 2, last_activity_at: at(2) });
    this.world.set("field-notes", { id: "field-notes", name: "Field notes", seed: false, status: "active", created_at: at(8), created_by_member: "ivo", members: 1, owners: 1, last_activity_at: null });
    this.world.set("old-pilot", {
      id: "old-pilot",
      name: "Old pilot",
      seed: false,
      status: "deleted",
      created_at: at(40),
      created_by_member: "jun",
      members: 0,
      owners: 0,
      last_activity_at: at(4),
      deleted_at: at(3),
      reserved_until: iso(t - 3 * DAY_MS + RESERVE_MS)
    });
  }
  now;
  manifestPath;
  defaultTeam = DEMO_TEAM;
  held = /* @__PURE__ */ new Map();
  /** Teams alice created and has not deleted (M9-SPEC §2's per-account count). */
  createdByMe = /* @__PURE__ */ new Set();
  world = /* @__PURE__ */ new Map();
  invitations;
  /** One of alice's active teams (the default when none is named), else NotFound. */
  team(id = DEMO_TEAM) {
    const t = this.held.get(id);
    if (!t) throw new NotFound();
    return t;
  }
  /** GET /v1/me/teams as alice reads it: the file's team first, then the created ones by id. */
  myTeams() {
    const ids = [...this.held.keys()].sort((a, b) => a === DEMO_TEAM ? -1 : b === DEMO_TEAM ? 1 : a.localeCompare(b));
    return {
      teams: ids.map((id) => {
        const t = this.held.get(id);
        const me = t.me();
        return { team: id, name: t.name, member: me.member, role: me.role };
      }),
      invitations: this.invitations.map((i) => ({ team: i.team, name: i.name, member: i.member, role: i.role, invited_by_member: i.invited_by_member })),
      admin: true,
      teams_created: this.createdByMe.size,
      max_teams_created: DEMO_MAX_TEAMS_CREATED,
      suggested_member: DEMO_ME
    };
  }
  taken(id) {
    const w = this.world.get(id);
    return RESERVED_TEAM_IDS.has(id) || w !== void 0 && (w.status === "active" || Date.parse(w.reserved_until ?? "") > this.now());
  }
  /** POST /v1/teams, with the relay's refusals (M9-SPEC §2, §7.4). */
  createTeam(body) {
    const name = body.name.trim();
    const id = body.id ?? teamIdFromName(name);
    if (!NEW_TEAM_ID.test(id)) throw new RosterRefusal(422, "invalid_body", "The team id must be 3 to 32 characters: a lower-case letter, then lower-case letters, digits or -.");
    if (this.taken(id)) throw new RosterRefusal(409, "team_id_unavailable", "That team id is not available. Choose another.");
    if (name.replace(/\s+/g, " ").toLowerCase() === "demo") {
      throw new RosterRefusal(409, "team_name_unavailable", "That name belongs to a team in the relay's configuration. Choose another.");
    }
    if (this.createdByMe.size >= DEMO_MAX_TEAMS_CREATED) {
      throw new RosterRefusal(409, "team_limit", `You have created ${DEMO_MAX_TEAMS_CREATED} teams, the most one account may. Delete one to create another.`);
    }
    const created = iso(this.now());
    const member = body.owner_member_id;
    const team = new DemoTeam(this.now, this.manifestPath, {
      team: id,
      name,
      viewer: member,
      roster: [{ member, emails: ["alice@example.com"], role: "owner", added_by: member, added_at: created, status: "active" }]
    });
    this.held.set(id, team);
    this.createdByMe.add(id);
    this.world.set(id, { id, name, seed: false, status: "active", created_at: created, created_by_member: member, members: 0, owners: 0, last_activity_at: null });
    return { team: id, name, status: "active", created_at: created, member, role: "owner" };
  }
  /** POST /v1/me/invitations/{team} (M9-SPEC §7.2). */
  answerInvitation(team, accept) {
    const inv = this.invitations.find((i) => i.team === team);
    if (!inv) throw new RosterRefusal(404, "not_found", "That invitation is no longer open.");
    this.invitations = this.invitations.filter((i) => i !== inv);
    if (!accept) return { team, member: inv.member, status: "declined" };
    this.held.set(
      team,
      new DemoTeam(this.now, this.manifestPath, {
        team,
        name: inv.name,
        viewer: inv.member,
        roster: inv.roster,
        ...inv.boundaries ? { boundaries: inv.boundaries } : {}
      })
    );
    return { team, name: inv.name, member: inv.member, role: inv.role, status: "active" };
  }
  remove(team, confirm) {
    const w = this.world.get(team);
    if (!w || w.status !== "active") throw new NotFound();
    if (w.seed) throw new RosterRefusal(409, "seed_team", "This team comes from the relay's team file; it cannot be deleted here.");
    if (confirm !== team) throw new RosterRefusal(422, "confirm_mismatch", 'Send {"confirm": "<team id>"} to delete the team.');
    const t = this.now();
    w.status = "deleted";
    w.deleted_at = iso(t);
    w.reserved_until = iso(t + RESERVE_MS);
    this.held.delete(team);
    this.createdByMe.delete(team);
    this.invitations = this.invitations.filter((i) => i.team !== team);
    return { team, status: "deleted", removal: "complete", deleted_at: w.deleted_at, reserved_until: w.reserved_until };
  }
  /** DELETE /v1/teams/{team}: an owner deletes a team the API created (M9-SPEC §7.7). */
  deleteTeam(team, confirm) {
    const held = this.team(team);
    if (held.viewerRole() !== "owner") throw new RosterRefusal(403, "forbidden", "Only an owner can delete the team.");
    return this.remove(team, confirm);
  }
  /** GET /v1/admin/teams (M9-SPEC §4): the file's teams first, then the others by id. */
  adminTeams(q = {}) {
    const limit = q.limit ?? 200;
    const row = (w) => {
      const held = this.held.get(w.id);
      const counts = held ? held.counts() : { members: w.members, owners: w.owners };
      return {
        id: w.id,
        name: w.name,
        status: w.status,
        seed: w.seed,
        created_at: w.created_at,
        created_by_member: w.created_by_member,
        ...counts,
        last_activity_at: w.id === DEMO_TEAM ? iso(this.now() - 2e4) : w.last_activity_at,
        ...w.status === "deleted" ? { removal: "complete", deleted_at: w.deleted_at, reserved_until: w.reserved_until } : {}
      };
    };
    const all = [...this.world.values()];
    const seeds = q.after === void 0 ? all.filter((w) => w.seed) : [];
    const rest = all.filter((w) => !w.seed && (q.after === void 0 || w.id > q.after)).filter((w) => w.status === "active" || Date.parse(w.reserved_until ?? "") > this.now()).sort((a, b) => a.id.localeCompare(b.id));
    const page = rest.slice(0, limit);
    return { teams: [...seeds, ...page].map(row), next: rest.length > limit ? page.at(-1).id : null };
  }
  /** DELETE /v1/admin/teams/{team} (M9-SPEC §4). */
  adminDeleteTeam(team, confirm) {
    return this.remove(team, confirm);
  }
};

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var strictDecoder = new TextDecoder("utf-8", { fatal: true });
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0), buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers)
    buf.set(buffer, i), i += buffer.length;
  return buf;
}
var NON_ASCII = /[^\x00-\x7f]/;
function encode(string) {
  if (typeof string == "string" && string.length >= 128) {
    if (NON_ASCII.test(string))
      throw new TypeError("non-ASCII string encountered in encode()");
    return encoder.encode(string);
  }
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127)
      throw new TypeError("non-ASCII string encountered in encode()");
    bytes[i] = code;
  }
  return bytes;
}
function decodeBase64(encoded, url = false) {
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(encoded, { alphabet: url ? "base64url" : "base64" });
  if (url) {
    if (encoded.includes("+") || encoded.includes("/"))
      throw new TypeError("Invalid base64url");
    encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  }
  const binary = atob(encoded), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options), this.name = this.constructor.name, Error.captureStackTrace?.(this, this.constructor);
  }
};
var JWTClaimValidationFailed = class extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JWTExpired = class extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } }), this.claim = claim, this.reason = reason, this.payload = payload;
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/util/base64url.js
var invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  try {
    return decodeBase64(typeof input == "string" ? input : decoder.decode(input), true);
  } catch (cause) {
    throw new TypeError(invalid, { cause });
  }
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/validate.js
function isObject(input) {
  if (typeof input != "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]")
    return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers)
    if (header)
      for (const parameter of Object.keys(header)) {
        if (parameters.has(parameter))
          return false;
        parameters.add(parameter);
      }
  return true;
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
function encodeBase64url(value, label, ErrorClass) {
  try {
    return encode(value);
  } catch {
    throw new ErrorClass(`The ${label} is not a valid base64url string`);
  }
}
function parseJoseHeader(b64, ErrorClass, message2) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(b64)));
  } catch {
    throw new ErrorClass(message2);
  }
  if (!isObject(parsed))
    throw new ErrorClass(message2);
  return parsed;
}
var JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s != "string")))
    throw new TypeError(`"${option}" option must be an array of strings`);
  return algorithms === void 0 ? void 0 : new Set(algorithms);
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0)
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  if (!protectedHeader || protectedHeader.crit === void 0)
    return [];
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input != "string" || input.length === 0))
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized))
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0)
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0))
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
  }
  return protectedHeader.crit;
}
function validateB64(protectedHeader, extensions) {
  if (extensions.includes("b64")) {
    const b64 = protectedHeader.b64;
    if (typeof b64 != "boolean")
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    return b64;
  }
  return true;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/key.js
var tag = (key) => key[Symbol.toStringTag];
var jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected)
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
  }
  if (key.alg !== void 0 && key.alg !== alg)
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp))
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
  }
};
async function prepareKey(entry, key, usage) {
  const { alg, secret } = entry, privateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return key;
  let normalized, keyObject;
  if (isObject(key)) {
    if (normalized = normalizeJwk(key), typeof normalized.kty != "string")
      throw invalidKeyType(alg, key, secret);
    if (!(secret ? normalized.kty === "oct" && typeof normalized.k == "string" : normalized.kty !== "oct" && (privateKey ? normalized.kty === "AKP" && typeof normalized.priv == "string" || typeof normalized.d == "string" : normalized.d === void 0 && normalized.priv === void 0)))
      throw new TypeError(secret ? 'JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present' : `JSON Web Key for this operation must be a ${privateKey ? "private" : "public"} JWK`);
    if (jwkMatchesOp(entry, normalized, usage), normalized.kty === "oct")
      return decode(normalized.k);
    if (!Object.isFrozen(key)) {
      const { key_ops } = key;
      Array.isArray(key_ops) && Object.freeze(key_ops), Object.freeze(key);
    }
  } else {
    if (!isKeyLike(key))
      throw invalidKeyType(alg, key, secret);
    const expectedType = secret ? "secret" : privateKey ? "private" : "public";
    if (key.type !== expectedType && (secret || ["secret", "public", "private"].includes(key.type)))
      throw new TypeError(`${tag(key)} instances must be of type "${expectedType}" for the ${alg} algorithm`);
    if (isCryptoKey(key))
      return key;
    if (keyObject = key, keyObject.type === "secret")
      return keyObject.export();
  }
  cache ||= /* @__PURE__ */ new WeakMap();
  const cacheKey = key;
  let cached = cache.get(cacheKey);
  if (cached?.[alg])
    return cached[alg];
  if (cached || cache.set(cacheKey, cached = {}), keyObject && typeof keyObject.toCryptoKey == "function") {
    const isPublic = keyObject.type === "public", crv = nist[keyObject.asymmetricKeyDetails?.namedCurve], params = entry.resolve?.({ crv, asymmetricKeyType: keyObject.asymmetricKeyType }) ?? entry.subtle;
    return cached[alg] = keyObject.toCryptoKey(params, isPublic, entry.usages[isPublic ? 0 : 1]);
  }
  return normalized ??= keyObject.export({ format: "jwk" }), normalized.alg = alg, cached[alg] = await jwkToKey(entry, normalized);
}
var cache;
var nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else types.length === 2 ? msg += `one of type ${types[0]} or ${types[1]}.` : msg += `of type ${types[0]}.`;
  return actual == null ? msg += ` Received ${actual}` : typeof actual == "function" && actual.name ? msg += ` Received function ${actual.name}` : typeof actual == "object" && actual != null && actual.constructor?.name && (msg += ` Received an instance of ${actual.constructor.name}`), msg;
}
function invalidKeyType(alg, actual, secret) {
  const types = ["CryptoKey", "KeyObject", "JSON Web Key"];
  return secret && types.push("Uint8Array"), new TypeError(message(`Key for the ${alg} algorithm must be `, actual, ...types));
}
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage))
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength != "number" || modulusLength < 2048)
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name)
    throw unusable(expected.name);
  if (expected.hash && algorithm.hash?.name !== expected.hash)
    throw unusable(expected.hash, "algorithm.hash");
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve)
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  if (expected.length !== void 0 && algorithm.length !== expected.length)
    throw unusable(expected.length, "algorithm.length");
  checkUsage(key, usage);
}
function snapshotJwk(jwk) {
  return { __proto__: null, ...jwk };
}
function normalizeJwk(jwk) {
  const normalized = snapshotJwk(jwk);
  if (normalized.ext !== void 0 && typeof normalized.ext != "boolean")
    throw new TypeError('"ext" (Extractable) Parameter must be a boolean');
  if (normalized.key_ops !== void 0) {
    const value = normalized.key_ops, keyOps = Array.isArray(value) ? [...value] : void 0;
    if (!keyOps || keyOps.some((operation) => typeof operation != "string") || new Set(keyOps).size !== keyOps.length)
      throw new TypeError('"key_ops" (Key Operations) Parameter must be an array of unique strings');
    normalized.key_ops = keyOps;
  }
  return normalized;
}
function validateExtractableOption(extractable) {
  if (extractable !== void 0 && typeof extractable != "boolean")
    throw new TypeError('"extractable" option must be a boolean');
  return extractable;
}
async function jwkToKey(entry, jwk, extractable) {
  if (!entry.kty.includes(jwk.kty))
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle, isPrivate = !!(jwk.d || jwk.priv), keyData = { ...jwk, ext: extractable ?? jwk.ext };
  return keyData.kty !== "AKP" && delete keyData.alg, delete keyData.use, crypto.subtle.importKey("jwk", keyData, algorithm, keyData.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
async function rawKey(key, expected, usage, extractable = false) {
  return key instanceof Uint8Array && (key = await crypto.subtle.importKey("raw", key, expected, extractable, [usage])), checkCryptoKey(key, expected, usage), key;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/key_descriptor.js
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries)
    out[alg] = { ...entries[alg], alg };
  return out;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jwe_algorithms.js
var wrap = [
  ["encrypt", "wrapKey"],
  ["decrypt", "unwrapKey"]
];
var derive = [[], ["deriveBits"]];
var none = [[], []];
function rsaes(bits) {
  return {
    kty: ["RSA"],
    mode: "key-encryption",
    subtle: { name: "RSA-OAEP", hash: `SHA-${bits}` },
    usages: wrap,
    ops: ["wrapKey", "unwrapKey"]
  };
}
function ecdh(mode) {
  return {
    kty: ["EC", "OKP"],
    mode,
    subtle: { name: "ECDH" },
    resolve: ({ kty, crv, asymmetricKeyType }) => {
      if (crv === "X25519" || asymmetricKeyType === "x25519")
        return { name: "X25519" };
      if (kty === "OKP")
        throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      return { name: "ECDH", namedCurve: crv };
    },
    usages: derive,
    ops: [void 0, "deriveBits"]
  };
}
function aeskw(bits, gcm = false) {
  return {
    kty: ["oct"],
    mode: "key-wrapping",
    secret: true,
    subtle: { name: gcm ? "AES-GCM" : "AES-KW", length: bits },
    usages: none,
    ops: gcm ? ["encrypt", "decrypt"] : ["wrapKey", "unwrapKey"]
  };
}
function pbes2() {
  return {
    kty: ["oct"],
    mode: "key-wrapping",
    secret: true,
    subtle: { name: "PBKDF2" },
    usages: none,
    ops: ["deriveBits", "deriveBits"]
  };
}
var JWE = table({
  dir: {
    kty: ["oct"],
    mode: "direct-encryption",
    secret: true,
    subtle: { name: "AES-GCM" },
    usages: none,
    ops: ["encrypt", "decrypt"]
  },
  "RSA-OAEP": rsaes(1),
  "RSA-OAEP-256": rsaes(256),
  "RSA-OAEP-384": rsaes(384),
  "RSA-OAEP-512": rsaes(512),
  "ECDH-ES": ecdh("direct-key-agreement"),
  "ECDH-ES+A128KW": ecdh("key-agreement-with-key-wrapping"),
  "ECDH-ES+A192KW": ecdh("key-agreement-with-key-wrapping"),
  "ECDH-ES+A256KW": ecdh("key-agreement-with-key-wrapping"),
  A128KW: aeskw(128),
  A192KW: aeskw(192),
  A256KW: aeskw(256),
  A128GCMKW: aeskw(128, true),
  A192GCMKW: aeskw(192, true),
  A256GCMKW: aeskw(256, true),
  "PBES2-HS256+A128KW": pbes2(),
  "PBES2-HS384+A192KW": pbes2(),
  "PBES2-HS512+A256KW": pbes2()
});
var contentOps = ["encrypt", "decrypt"];
function contentEncryption(bits, cbc = false) {
  return {
    kty: ["oct"],
    secret: true,
    subtle: { name: cbc ? "AES-CBC" : "AES-GCM", length: bits },
    usages: none,
    ops: contentOps,
    cekBits: bits,
    ivBits: cbc ? 128 : 96,
    cbc
  };
}
var ENC = table({
  A128GCM: contentEncryption(128),
  A192GCM: contentEncryption(192),
  A256GCM: contentEncryption(256),
  "A128CBC-HS256": contentEncryption(256, true),
  "A192CBC-HS384": contentEncryption(384, true),
  "A256CBC-HS512": contentEncryption(512, true)
});

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jws_algorithms.js
var sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const subtle = { name: saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5", hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(bits) {
  const subtle = { name: `ML-DSA-${bits}` };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
var JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg == "string" ? JWS[alg] : void 0;
  if (!entry)
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  return entry;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jws_verify.js
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
function parseProtectedHeader(encodedProtected) {
  return encodedProtected === void 0 ? {} : parseJoseHeader(encodedProtected, JWSInvalid, "JWS Protected Header is invalid");
}
function encodeCompactUnencodedPayload(payload) {
  try {
    return encode(payload);
  } catch {
    throw new JWSInvalid("JWS Compact Serialization payload must use only ASCII characters");
  }
}
async function verifySignature(jws, shared, key, encodeUnencodedPayload, parsedProtected) {
  const { protected: encodedProtected, header, payload: inputPayload } = jws, parsedProt = parsedProtected ?? parseProtectedHeader(encodedProtected);
  if (!isDisjoint(parsedProt, header))
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  const joseHeader = { ...parsedProt, ...header }, b64 = validateB64(parsedProt, validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], parsedProt, joseHeader)), { alg } = joseHeader;
  if (typeof alg != "string" || !alg)
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  if (shared[0] && !shared[0].has(alg))
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  if (b64) {
    if (typeof inputPayload != "string")
      throw new JWSInvalid("JWS Payload must be a string");
  } else if (typeof inputPayload != "string" && !(inputPayload instanceof Uint8Array))
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  const signingPayload = b64 || typeof inputPayload != "string" ? inputPayload : encodeUnencodedPayload(inputPayload);
  let resolvedKey = false;
  typeof key == "function" && (key = await key(parsedProt, jws), resolvedKey = true);
  const entry = jwsAlgorithm(alg), data = concat(encodedProtected !== void 0 ? encode(encodedProtected) : new Uint8Array(), encode("."), typeof signingPayload == "string" ? shared[2] ??= encodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload), signature = decodeBase64url(jws.signature, "signature", JWSInvalid), k = await prepareKey(entry, key, "verify"), cryptoKey = await rawKey(k, entry.subtle, "verify");
  entry.minRsaBits && checkModulusLength(entry.alg, cryptoKey);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(entry.signing, cryptoKey, signature, data);
  } catch {
  }
  if (!verified)
    throw new JWSSignatureVerificationFailed();
  const result = { payload: typeof signingPayload == "string" ? decodeBase64url(signingPayload, "payload", JWSInvalid) : signingPayload };
  return encodedProtected !== void 0 && (result.protectedHeader = parsedProt), header !== void 0 && (result.unprotectedHeader = header), resolvedKey ? [{ ...result, key: k }, b64] : [result, b64];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array && (jws = decoder.decode(jws)), typeof jws != "string")
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3)
    throw new JWSInvalid("Invalid Compact JWS");
  return verifySignature({ payload, protected: protectedHeader, signature }, shared, key, encodeCompactUnencodedPayload);
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/jwt_claims_set.js
var epoch = (date) => Math.floor(date.getTime() / 1e3);
var multipliers = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31557600
};
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
var checkFailed = "check_failed";
function invalidDuration() {
  throw new TypeError("Invalid time period format");
}
function secs(str) {
  typeof str != "string" && invalidDuration();
  const matched = REGEX.exec(str);
  (!matched || matched[4] && matched[1]) && invalidDuration();
  const value = parseFloat(matched[2]), numericDate2 = Math.round(value * multipliers[matched[3][0].toLowerCase()]);
  return Number.isFinite(numericDate2) || invalidDuration(), matched[1] === "-" || matched[4] === "ago" ? -numericDate2 : numericDate2;
}
function validateInput(label, input) {
  if (!Number.isFinite(input))
    throw new TypeError(`Invalid ${label} input`);
  return input;
}
var normalizeTyp = (value) => {
  const normalized = value.toLowerCase();
  return value.includes("/") ? normalized : `application/${normalized}`;
};
var checkAudiencePresence = (audPayload, audOption) => typeof audPayload == "string" ? audOption.includes(audPayload) : Array.isArray(audPayload) ? audOption.some((aud) => audPayload.includes(aud)) : false;
function validateNumericDate(payload, claim, required = false) {
  const value = payload[claim];
  if (!(value === void 0 && !required)) {
    if (typeof value != "number")
      throw new JWTClaimValidationFailed(`"${claim}" claim must be a number`, payload, claim, "invalid");
    return value;
  }
}
function unexpectedClaim(payload, claim) {
  throw new JWTClaimValidationFailed(`unexpected "${claim}" claim value`, payload, claim, checkFailed);
}
function validateClaimsSet(protectedHeader, encodedPayload, options = {}) {
  let payload;
  try {
    payload = JSON.parse(strictDecoder.decode(encodedPayload));
  } catch {
  }
  if (!isObject(payload))
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  const { typ } = options;
  if (typ !== void 0 && (typeof protectedHeader.typ != "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ)))
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", checkFailed);
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options, presenceCheck = [...requiredClaims];
  maxTokenAge !== void 0 && presenceCheck.push("iat"), audience !== void 0 && presenceCheck.push("aud"), subject !== void 0 && presenceCheck.push("sub"), issuer !== void 0 && presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse()))
    if (!Object.hasOwn(payload, claim))
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
  issuer !== void 0 && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss) && unexpectedClaim(payload, "iss"), subject !== void 0 && payload.sub !== subject && unexpectedClaim(payload, "sub"), audience !== void 0 && !checkAudiencePresence(payload.aud, typeof audience == "string" ? [audience] : audience) && unexpectedClaim(payload, "aud");
  const { clockTolerance } = options;
  let tolerance = 0;
  if (typeof clockTolerance == "string")
    tolerance = secs(clockTolerance);
  else if (clockTolerance !== void 0) {
    if (typeof clockTolerance != "number")
      throw new TypeError("Invalid clockTolerance option type");
    tolerance = clockTolerance;
  }
  validateInput("clockTolerance option", tolerance);
  const { currentDate } = options, now = validateInput("currentDate option", epoch(currentDate === void 0 ? /* @__PURE__ */ new Date() : currentDate)), iat = validateNumericDate(payload, "iat", maxTokenAge !== void 0), nbf = validateNumericDate(payload, "nbf");
  if (nbf !== void 0 && nbf > now + tolerance)
    throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", checkFailed);
  const exp = validateNumericDate(payload, "exp");
  if (exp !== void 0 && exp <= now - tolerance)
    throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", checkFailed);
  if (maxTokenAge !== void 0) {
    const age = now - iat, max = validateInput("maxTokenAge option", typeof maxTokenAge == "number" ? maxTokenAge : secs(maxTokenAge));
    if (age - tolerance > max)
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", checkFailed);
    if (age < -tolerance)
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", checkFailed);
  }
  return payload;
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const [verified, b64] = await verifyCompact(jwt, prepareVerify(options), key);
  if (!b64)
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  const payload = validateClaimsSet(verified.protectedHeader, verified.payload, options);
  return { ...verified, payload };
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/lib/key_algorithm.js
function unsupportedAlg(source = 'JWK "alg" (Algorithm) Parameter') {
  throw new JOSENotSupported(`Invalid or unsupported ${source} value`);
}
function keyAlgorithm(alg, source) {
  return (typeof alg == "string" ? JWS[alg] ?? JWE[alg] : void 0) ?? unsupportedAlg(source);
}

// node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/key/import.js
async function importJWK(jwk, alg, options) {
  if (!isObject(jwk))
    throw new TypeError("JWK must be an object");
  const normalized = normalizeJwk(jwk), extractable = validateExtractableOption(options?.extractable), { alg: jwkAlg } = normalized;
  if (alg ??= jwkAlg, normalized.kty !== "oct" && !alg)
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  switch (normalized.kty) {
    case "oct":
      if (typeof normalized.k != "string")
        throw new TypeError('missing "k" (Key Value) Parameter value');
      return decode(normalized.k);
    case "AKP": {
      if (typeof jwkAlg != "string" || !jwkAlg)
        throw new TypeError('missing "alg" (Algorithm) Parameter value');
      if (alg !== jwkAlg)
        throw new TypeError("JWK alg and alg option value mismatch");
      return jwkToKey(keyAlgorithm(alg), normalized, extractable);
    }
    case "RSA":
    case "EC":
    case "OKP":
      return jwkToKey(keyAlgorithm(alg), normalized, extractable);
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}

// src/iap.ts
var IAP_ISSUER = "https://cloud.google.com/iap";
var IAP_JWK_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
var IAP_HEADER = "x-goog-iap-jwt-assertion";
var CLOCK_SKEW_S = 30;
var UNKNOWN_KID_REFETCH_MS = 5 * 6e4;
var MIN_KEYS_TTL_MS = 6e4;
var MAX_KEYS_TTL_MS = 24 * 60 * 6e4;
var DEFAULT_KEYS_TTL_MS = 5 * 6e4;
var FAILED_REFRESH_RETRY_MS = 3e4;
var STALE_KEYS_GRACE_MS = 60 * 6e4;
var MAX_TOKEN_LENGTH = 8192;
var MAX_JWKS_BYTES = 64 * 1024;
var JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
var AUDIENCE_RE = /^\/projects\/[0-9]{1,20}\/[A-Za-z0-9/._-]{1,256}$/;
function keysTtlMs(cacheControl, age) {
  let ttl = DEFAULT_KEYS_TTL_MS;
  if (cacheControl) {
    const directives = cacheControl.toLowerCase().split(",").map((d) => d.trim());
    if (directives.includes("no-store") || directives.includes("no-cache")) {
      ttl = MIN_KEYS_TTL_MS;
    } else {
      const m = directives.map((d) => /^max-age=(\d{1,10})$/.exec(d)).find((x) => x !== null);
      if (m) {
        const ageS = age && /^\d{1,10}$/.test(age.trim()) ? Number(age.trim()) : 0;
        ttl = (Number(m[1]) - ageS) * 1e3;
      }
    }
  }
  return Math.min(MAX_KEYS_TTL_MS, Math.max(MIN_KEYS_TTL_MS, ttl));
}
var IapKeySet = class {
  url;
  fetcher;
  now;
  timeoutMs;
  log;
  keys = /* @__PURE__ */ new Map();
  /** Until when `keys` is fresh; 0 before the first fetch. */
  freshUntil = 0;
  /** Until when `keys` may still be used after failed refreshes. */
  usableUntil = 0;
  /** When the last fetch (successful or not) started. */
  lastFetchAt = Number.NEGATIVE_INFINITY;
  inflight = null;
  /** Fetches made, for tests and the log. */
  fetches = 0;
  constructor(opts = {}) {
    this.url = opts.url ?? IAP_JWK_URL;
    this.fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5e3;
    this.log = opts.log ?? (() => {
    });
  }
  async load() {
    this.fetches++;
    this.lastFetchAt = this.now();
    let res;
    try {
      res = await this.fetcher(this.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new Error("IAP key set unreachable");
    }
    if (!res.ok) throw new Error(`IAP key set answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_JWKS_BYTES) throw new Error("IAP key set too large");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("IAP key set is not JSON");
    }
    const list2 = body?.keys;
    if (!Array.isArray(list2)) throw new Error("IAP key set has no keys");
    const next = /* @__PURE__ */ new Map();
    for (const jwk of list2) {
      if (!jwk || typeof jwk !== "object") continue;
      const k = jwk;
      if (typeof k.kid !== "string" || !k.kid || k.kty !== "EC" || k.crv !== "P-256") continue;
      if (k.alg !== void 0 && k.alg !== "ES256") continue;
      if (k.use !== void 0 && k.use !== "sig") continue;
      if ("d" in k) continue;
      try {
        next.set(k.kid, await importJWK({ kty: "EC", crv: "P-256", x: k.x, y: k.y }, "ES256"));
      } catch {
      }
    }
    if (next.size === 0) throw new Error("IAP key set has no ES256 keys");
    const ttl = keysTtlMs(res.headers.get("cache-control"), res.headers.get("age"));
    this.keys = next;
    this.freshUntil = this.now() + ttl;
    this.usableUntil = this.freshUntil + STALE_KEYS_GRACE_MS;
  }
  /** One refresh at a time; every caller waits for the same one. */
  refresh() {
    this.inflight ??= this.load().catch((err) => {
      this.log(`iap: key refresh failed (${err instanceof Error ? err.message : "error"})`);
      this.freshUntil = this.now() + FAILED_REFRESH_RETRY_MS;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
  /** The key for `kid`, refreshing the set when it is stale or (rate-limited) when kid is unknown. */
  async key(kid) {
    if (this.now() >= this.freshUntil) {
      await this.refresh();
    } else if (!this.keys.has(kid) && this.now() - this.lastFetchAt >= UNKNOWN_KID_REFETCH_MS) {
      await this.refresh();
    }
    if (this.now() >= this.usableUntil) return null;
    return this.keys.get(kid) ?? null;
  }
};
function checkIapAudience(raw) {
  const v = raw?.trim();
  if (!v) throw new Error("IAP_AUDIENCE must be set");
  if (!AUDIENCE_RE.test(v) || v.includes("//") || v.split("/").includes("..")) {
    throw new Error("IAP_AUDIENCE must look like /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME");
  }
  return v;
}
function iapVerifier(opts) {
  const now = opts.now ?? Date.now;
  const log2 = opts.log ?? (() => {
  });
  const audience = opts.audience;
  const reject = (why) => {
    log2(`iap: refused (${why})`);
    return null;
  };
  return async (assertion) => {
    if (assertion === void 0 || assertion === "") return reject("no assertion");
    if (assertion.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(assertion)) return reject("malformed");
    let header;
    try {
      header = JSON.parse(Buffer.from(assertion.split(".")[0], "base64url").toString("utf8"));
    } catch {
      return reject("malformed header");
    }
    if (!header || typeof header !== "object") return reject("malformed header");
    if (header.alg !== "ES256") return reject("algorithm");
    if (typeof header.kid !== "string" || header.kid === "" || header.kid.length > 256) return reject("no kid");
    const key = await opts.keys.key(header.kid);
    if (!key) return reject("unknown kid");
    const nowS = Math.floor(now() / 1e3);
    let payload;
    try {
      ({ payload } = await jwtVerify(assertion, key, {
        algorithms: ["ES256"],
        issuer: IAP_ISSUER,
        audience,
        clockTolerance: CLOCK_SKEW_S,
        requiredClaims: ["exp", "iat", "email"],
        currentDate: new Date(nowS * 1e3)
      }));
    } catch (err) {
      const code = err.code;
      return reject(typeof code === "string" ? code : "invalid");
    }
    if (payload.aud !== audience) return reject("audience");
    const { iat, exp, email: email2 } = payload;
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat > nowS + CLOCK_SKEW_S) return reject("iat");
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowS - CLOCK_SKEW_S) return reject("exp");
    if (typeof email2 !== "string" || email2.length > 254 || !EMAIL_RE.test(email2)) return reject("email");
    return { email: email2.toLowerCase() };
  };
}

// src/relay-client.ts
import { execFile } from "node:child_process";
import { readFileSync as readFileSync4 } from "node:fs";

// src/credentials.ts
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

// src/relay-client-core.ts
var TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
var MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/;
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function parseRelayUrl(raw) {
  if (!raw) throw new Error("RELAY_URL must be set");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RELAY_URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("RELAY_URL must not carry credentials");
  if (url.search || url.hash) throw new Error("RELAY_URL must not carry a query or fragment");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new Error("RELAY_URL must be https (plain http is allowed only to localhost)");
}

// src/credentials.ts
var CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;
var EMAIL_RE2 = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
var CREDENTIALS_DIR = "team-relay";
var CREDENTIALS_FILE = "credentials.json";
var MAX_FILE_BYTES = 16 * 1024;
var CredentialFileError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "CredentialFileError";
  }
};
function credentialsPath(env = process.env) {
  const explicit = env.RELAY_CREDENTIALS_FILE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new CredentialFileError("RELAY_CREDENTIALS_FILE must be an absolute path");
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, CREDENTIALS_DIR, CREDENTIALS_FILE);
}
function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
function checkOwnedPrivate(st, what, kind) {
  if (st.isSymbolicLink()) throw new CredentialFileError(`${what} is a symbolic link; refusing to use it`);
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new CredentialFileError(`${what} is not a ${kind}; refusing to use it`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new CredentialFileError(`${what} is owned by another user; refusing to use it`);
  if ((st.mode & 63) !== 0) {
    const mode = (st.mode & 511).toString(8).padStart(3, "0");
    throw new CredentialFileError(
      `${what} has mode ${mode}, readable or writable by others; refusing to use it (run /team-relay:logout and /team-relay:login again, or chmod ${kind === "file" ? "600" : "700"} it)`
    );
  }
}
var RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
function normaliseRelayUrl(raw) {
  const url = parseRelayUrl(raw);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}
function parseStoredCredential(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CredentialFileError("the credential file is not a JSON object");
  const c = raw;
  const { relay_url, team, member, credential, expires_at, email: email2 } = c;
  if (typeof relay_url !== "string") throw new CredentialFileError("the credential file has no relay_url");
  let url;
  try {
    url = normaliseRelayUrl(relay_url);
  } catch {
    throw new CredentialFileError("the credential file has an invalid relay_url");
  }
  if (typeof team !== "string" || !TEAM_RE.test(team)) throw new CredentialFileError("the credential file has an invalid team");
  if (typeof member !== "string" || !MEMBER_RE.test(member)) throw new CredentialFileError("the credential file has an invalid member");
  if (typeof credential !== "string" || !CREDENTIAL_RE.test(credential)) throw new CredentialFileError("the credential file has an invalid credential");
  if (expires_at !== void 0 && expires_at !== null && (typeof expires_at !== "string" || !RFC3339.test(expires_at))) {
    throw new CredentialFileError("the credential file has an invalid expires_at");
  }
  if (email2 !== void 0 && email2 !== null && (typeof email2 !== "string" || email2.length > 254 || !EMAIL_RE2.test(email2))) {
    throw new CredentialFileError("the credential file has an invalid email");
  }
  return {
    relay_url: url,
    team,
    member,
    credential,
    expires_at: typeof expires_at === "string" ? expires_at : null,
    ...typeof email2 === "string" ? { email: email2 } : {}
  };
}
function readCredential(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw new CredentialFileError(`cannot read the credential file (${err.code ?? "error"})`);
  }
  checkOwnedPrivate(lstatSync(dirname(path)), "the credential directory", "directory");
  checkOwnedPrivate(st, "the credential file", "file");
  if (st.size > MAX_FILE_BYTES) throw new CredentialFileError("the credential file is too large");
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch (err) {
    throw new CredentialFileError(`cannot read the credential file (${err.code ?? "error"})`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredentialFileError("the credential file is not valid JSON");
  }
  return parseStoredCredential(json);
}
function credentialFileExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// src/relay-default.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function defaultRelayFile() {
  return fileURLToPath2(new URL("../relay.default.json", import.meta.url));
}
function defaultRelayUrl(file = defaultRelayFile()) {
  try {
    const raw = JSON.parse(readFileSync3(file, "utf8"));
    if (typeof raw.relay_url !== "string") return null;
    parseRelayUrl(raw.relay_url);
    return raw.relay_url;
  } catch {
    return null;
  }
}

// src/relay-client.ts
var REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
var RelayError = class extends Error {
  status;
  code;
  detail;
  constructor(status, code, detail) {
    super(`relay ${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
};
var RelayNetworkError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "RelayNetworkError";
  }
};
function isRetryable(err) {
  if (err instanceof RelayNetworkError) return true;
  if (err instanceof RelayError) return err.status >= 500 || err.status === 429;
  return false;
}
var DEFAULT_BACKOFF = { baseMs: 1e3, maxMs: 3e4 };
function backoffDelay(attempt, b = DEFAULT_BACKOFF, random = Math.random) {
  const exp = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}
function configValue(v) {
  if (v === void 0) return void 0;
  const t = v.trim();
  if (!t || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(t)) return void 0;
  return t;
}
function staticTokenProvider(read) {
  return Object.assign(typeof read === "string" ? () => read : read, { kind: "static" });
}
function tokenProviderFromEnv(env) {
  const file = configValue(env.RELAY_TOKEN_FILE);
  if (file) {
    return staticTokenProvider(() => {
      let raw;
      try {
        raw = readFileSync4(file, "utf8");
      } catch (err) {
        throw new Error(`cannot read RELAY_TOKEN_FILE (${err.code ?? "error"})`);
      }
      const token2 = raw.replace(/[\r\n]+$/, "");
      if (!token2) throw new Error("RELAY_TOKEN_FILE is empty");
      return token2;
    });
  }
  const token = configValue(env.RELAY_TOKEN);
  if (!token) throw new Error('RELAY_AUTH is "token", so RELAY_TOKEN or RELAY_TOKEN_FILE must be set');
  return staticTokenProvider(token);
}
var TOKEN_REFRESH_MARGIN_MS = 5 * 6e4;
var JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var ACCOUNT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
var GCLOUD_OUTPUT_LIMIT = 64 * 1024;
function checkGcloudAccount(account) {
  if (account.length > 254 || !ACCOUNT_RE.test(account)) {
    throw new Error("RELAY_GCLOUD_ACCOUNT must be an account email address");
  }
  return account;
}
function jwtExpiryMs(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1e3 : null;
  } catch {
    return null;
  }
}
function scrub(text) {
  return text.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/ya29\.[A-Za-z0-9_.-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
}
function gcloudTokenProvider(opts = {}) {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 3e4;
  const args = ["auth", "print-identity-token"];
  if (opts.account !== void 0) args.push(`--account=${checkGcloudAccount(opts.account)}`);
  let cached = null;
  let inflight = null;
  const mint = () => new Promise((resolve, reject) => {
    execFile(
      "gcloud",
      args,
      { env, timeout: timeoutMs, maxBuffer: GCLOUD_OUTPUT_LIMIT, shell: false, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = err;
          if (e.code === "ENOENT") return reject(new Error("gcloud was not found on PATH (RELAY_AUTH=google needs the Google Cloud CLI)"));
          if (e.killed) return reject(new Error("gcloud auth print-identity-token timed out"));
          const why = scrub(String(stderr ?? "").split("\n").find((l) => l.trim()) ?? "");
          return reject(new Error(`gcloud auth print-identity-token failed${why ? `: ${why}` : ""}`));
        }
        const token = String(stdout).trim();
        if (!JWT_RE.test(token)) return reject(new Error("gcloud auth print-identity-token did not print an ID token"));
        resolve(token);
      }
    );
  });
  const provider = Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint().then((token) => {
      const exp = jwtExpiryMs(token);
      cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
      return token;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    }
  });
  return provider;
}
var METADATA_BASE = "http://metadata.google.internal";
var METADATA_IDENTITY_PATH = "/computeMetadata/v1/instance/service-accounts/default/identity";
var METADATA_OUTPUT_LIMIT = 16 * 1024;
function metadataTokenProvider(opts) {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 5e3;
  if (!opts.audience) throw new Error("RELAY_AUTH=metadata needs RELAY_URL as the token audience");
  const url = new URL(METADATA_IDENTITY_PATH, opts.base ?? METADATA_BASE);
  url.searchParams.set("audience", opts.audience);
  url.searchParams.set("format", "full");
  const target = url.toString();
  let cached = null;
  let inflight = null;
  const mint = async () => {
    let res;
    try {
      res = await doFetch(target, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error("the metadata server did not answer (RELAY_AUTH=metadata runs only on Google Cloud)");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`the metadata server refused an identity token (${res.status})`);
    const token = text.trim();
    if (token.length > METADATA_OUTPUT_LIMIT || !JWT_RE.test(token)) throw new Error("the metadata server did not return an ID token");
    return token;
  };
  return Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint().then((token) => {
      const exp = jwtExpiryMs(token);
      cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
      return token;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    }
  });
}
function authModeFromEnv(env) {
  const explicit = configValue(env.RELAY_AUTH);
  if (explicit === void 0) return credentialFileExists(credentialsPath(env)) ? "credential" : "google";
  if (explicit !== "credential" && explicit !== "google" && explicit !== "token" && explicit !== "metadata") {
    throw new Error('RELAY_AUTH must be "credential", "google" or "token" (or "metadata" on Google Cloud)');
  }
  return explicit;
}
var NotConnected = class extends Error {
  constructor(message2 = "Not connected: run /team-relay:login") {
    super(message2);
    this.name = "NotConnected";
  }
};
var SIGN_IN_AGAIN = "the relay refused your sign-in (signed out, expired, or no longer on the team): run /team-relay:login again";
function credentialTokenProvider(path, bound) {
  const relay = normaliseRelayUrl(bound.relay_url);
  return Object.assign(
    () => {
      const stored = readCredential(path);
      if (!stored) throw new NotConnected();
      if (stored.relay_url !== relay || stored.team !== bound.team) {
        throw new NotConnected("you signed in to another relay or team since this started: restart it");
      }
      return stored.credential;
    },
    { kind: "credential", path }
  );
}
function isCredentialProvider(p) {
  return p.kind === "credential";
}
function connectionFromEnv(env, gcloud = {}) {
  const explicitMode = configValue(env.RELAY_AUTH) !== void 0;
  const mode = authModeFromEnv(env);
  if (mode === "credential") {
    const path = credentialsPath(env);
    const stored = readCredential(path);
    if (!stored) throw new NotConnected();
    const envUrl = configValue(env.RELAY_URL);
    if (envUrl !== void 0) {
      let same = false;
      try {
        same = normaliseRelayUrl(envUrl) === stored.relay_url;
      } catch {
        same = false;
      }
      if (!same) {
        throw new Error("RELAY_URL is not the relay you signed in to: unset it, or run /team-relay:logout and then /team-relay:login to sign in to it");
      }
    }
    const envTeam = configValue(env.RELAY_TEAM);
    if (envTeam !== void 0 && envTeam !== stored.team) {
      throw new Error("RELAY_TEAM is not the team you signed in to: unset it, or run /team-relay:login again");
    }
    return { mode, url: stored.relay_url, team: stored.team, member: stored.member, token: credentialTokenProvider(path, stored) };
  }
  const team = configValue(env.RELAY_TEAM);
  if (!team) {
    if (!explicitMode) throw new NotConnected();
    throw new Error("RELAY_TEAM must be set");
  }
  const url = configValue(env.RELAY_URL) ?? (mode === "google" ? defaultRelayUrl() : null) ?? "";
  let token;
  if (mode === "token") token = tokenProviderFromEnv(env);
  else if (mode === "metadata") token = metadataTokenProvider({ audience: configValue(env.RELAY_URL) ?? "" });
  else {
    const account = configValue(env.RELAY_GCLOUD_ACCOUNT);
    token = gcloudTokenProvider({ env, ...gcloud, ...account !== void 0 ? { account } : {} });
  }
  return { mode, url, team, token };
}
var CLIENT_IP_HASH_RE = /^[0-9a-f]{64}$/;
var ON_BEHALF_OF_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
var RelayClient = class _RelayClient {
  team;
  opts;
  base;
  token;
  backoff;
  attempts;
  timeoutMs;
  sleep;
  random;
  userAgent;
  constructor(opts) {
    if (!TEAM_RE.test(opts.team)) throw new Error("RELAY_TEAM is not a valid team id");
    this.opts = opts;
    this.team = opts.team;
    const base = parseRelayUrl(opts.url);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.base = base;
    this.token = opts.token;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? 3e4;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.userAgent = opts.userAgent ?? "team-relay-plugin/0.1.0";
  }
  /**
   * The same relay, sign-in and settings for another team (M9-SPEC §5: the hosted console's
   * delegate reads any team its viewer is on). The team id is checked like RELAY_TEAM.
   */
  withTeam(team) {
    if (team === this.team) return this;
    return new _RelayClient({ ...this.opts, team });
  }
  /**
   * True when this client signs in with a stored device credential or a static token, which
   * are bound to one team (no Google identity for the account routes).
   */
  get boundToTeam() {
    return isCredentialProvider(this.token) || this.token.kind === "static";
  }
  /** The relay's base URL (without a trailing slash). */
  get url() {
    return this.base.toString().replace(/\/$/, "");
  }
  teamPath(...parts) {
    return ["v1", "teams", this.team, ...parts].map(encodeURIComponent).join("/");
  }
  async once(method, path, body, timeoutMs, signal, onBehalfOf, clientIpHash2) {
    const url = new URL(path, this.base);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${await this.token()}`,
      "User-Agent": this.userAgent
    };
    if (onBehalfOf !== void 0) {
      if (!ON_BEHALF_OF_RE.test(onBehalfOf)) throw new Error("X-Relay-On-Behalf-Of must be a lower-case email address");
      headers["X-Relay-On-Behalf-Of"] = onBehalfOf;
    }
    if (clientIpHash2 !== void 0) {
      if (!CLIENT_IP_HASH_RE.test(clientIpHash2)) throw new Error("X-Relay-Client-IP-Hash must be 64 lower-case hex characters");
      headers["X-Relay-Client-IP-Hash"] = clientIpHash2;
    }
    let payload;
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: combined, redirect: "error" });
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err;
      const why = e.cause?.code ?? e.cause?.message ?? (e.name === "TimeoutError" ? "timed out" : e.name);
      throw new RelayNetworkError(`relay unreachable (${String(why).slice(0, 120)})`);
    }
    let text;
    try {
      text = await res.text();
    } catch {
      throw new RelayNetworkError("relay response was cut off");
    }
    let json = void 0;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new RelayNetworkError(`relay answered ${res.status} with a body that is not JSON`);
      }
    }
    if (!res.ok) {
      const obj = json && typeof json === "object" ? json : {};
      const code = typeof obj.error === "string" ? obj.error : `http_${res.status}`;
      const detail = typeof obj.detail === "string" ? obj.detail.slice(0, 500) : "";
      throw new RelayError(res.status, code, detail);
    }
    return json;
  }
  /**
   * One call with retry and exponential backoff on network errors, 5xx and 429. A 401 with
   * a refreshable identity drops the cached token and retries once at once (M2-SPEC §2).
   */
  async call(method, path, body, opts = {}) {
    const attempts = Math.max(1, opts.attempts ?? this.attempts);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let refreshed = false;
    for (let attempt = 0; ; ) {
      try {
        return await this.once(method, path, body, timeoutMs, opts.signal, opts.onBehalfOf, opts.clientIpHash);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (err instanceof RelayError && err.status === 401 && !refreshed && this.token.invalidate) {
          refreshed = true;
          this.token.invalidate();
          continue;
        }
        if (err instanceof RelayError && err.status === 401 && isCredentialProvider(this.token)) {
          throw new RelayError(401, err.code, SIGN_IN_AGAIN);
        }
        if (attempt + 1 >= attempts || !isRetryable(err)) throw err;
        await this.sleep(backoffDelay(attempt, this.backoff, this.random));
        attempt++;
      }
    }
  }
  me(opts) {
    return this.call("GET", this.teamPath("me"), void 0, opts);
  }
  publishManifest(member, manifest, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call(
      "PUT",
      this.teamPath("members", member, "manifest"),
      manifest,
      opts
    );
  }
  directory(opts) {
    return this.call("GET", this.teamPath("directory"), void 0, opts);
  }
  /**
   * M7-SPEC §1: what waits in this member's inbox for their answering session. A peek: it moves
   * no cursor and writes no presence, so a session without the channel may read it too.
   */
  inboxSummary(opts) {
    return this.call("GET", this.teamPath("inbox", "summary"), void 0, opts);
  }
  /** Safe to retry: the idempotency key makes a repeated POST return the original request. */
  createRequest(body, opts) {
    return this.call("POST", this.teamPath("requests"), body, opts);
  }
  readStream(stream, q = {}, opts) {
    const params = new URLSearchParams();
    if (q.after !== void 0) params.set("after", String(q.after));
    if (q.wait !== void 0) params.set("wait", String(q.wait));
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    const timeoutMs = opts?.timeoutMs ?? (q.wait ?? 0) * 1e3 + 2e4;
    return this.call("GET", this.teamPath("streams", stream) + (qs ? `?${qs}` : ""), void 0, {
      ...opts,
      timeoutMs
    });
  }
  ackCursor(stream, ackedSeq, opts) {
    return this.call("POST", this.teamPath("streams", stream, "cursor"), { acked_seq: ackedSeq }, opts);
  }
  checkRequestId(id) {
    if (!REQUEST_ID_RE.test(id)) throw new Error("request_id must look like rq_ followed by 32 lowercase hex characters");
  }
  ackRequest(requestId2, opts) {
    this.checkRequestId(requestId2);
    return this.call("POST", this.teamPath("requests", requestId2, "ack"), {}, opts);
  }
  reply(requestId2, body, opts) {
    this.checkRequestId(requestId2);
    return this.call(
      "POST",
      this.teamPath("requests", requestId2, "reply"),
      body,
      opts
    );
  }
  /** Not idempotent (it appends), so it is sent once unless the caller asks otherwise. */
  progress(requestId2, body, opts) {
    this.checkRequestId(requestId2);
    return this.call("POST", this.teamPath("requests", requestId2, "progress"), body, {
      attempts: 1,
      ...opts
    });
  }
  getRequest(requestId2, opts) {
    this.checkRequestId(requestId2);
    return this.call("GET", this.teamPath("requests", requestId2), void 0, opts);
  }
  /** M2-SPEC §3.3: a tool's name, outcome and duration only. Appends, so it is sent once. */
  toolEvent(requestId2, body, opts) {
    this.checkRequestId(requestId2);
    return this.call("POST", this.teamPath("requests", requestId2, "events"), body, {
      attempts: 1,
      ...opts
    });
  }
  /** M10-SPEC §1: the team's boundaries (any member). Never set: version 0, boundaries null. */
  boundaries(opts) {
    return this.call("GET", this.teamPath("boundaries"), void 0, opts);
  }
  /** M10-SPEC §1 (owners): replace the boundaries; a stale version is 409 version_conflict. Sent once. */
  setBoundaries(body, opts) {
    return this.call("PUT", this.teamPath("boundaries"), body, { attempts: 1, ...opts });
  }
  /** M11-SPEC §2: the boundaries version this member accepted (0: never). */
  acceptance(opts) {
    return this.call("GET", this.teamPath("me", "acceptance"), void 0, opts);
  }
  /** M11-SPEC §2: accept the current boundaries version (only for oneself). Sent once. */
  setAcceptance(version, opts) {
    return this.call("PUT", this.teamPath("me", "acceptance"), { version }, { attempts: 1, ...opts });
  }
  /** M11-SPEC §3: the background answerer's status (the member itself only). Sent once. */
  putStatus(body, opts) {
    return this.call("PUT", this.teamPath("me", "status"), body, { attempts: 1, ...opts });
  }
  /** M11-SPEC §3: every member's setup progress and whether they are answering now. */
  membersStatus(opts) {
    return this.call("GET", this.teamPath("members", "status"), void 0, opts);
  }
  /** M11-SPEC §4: this member's recent requests, newest first. */
  myRequests(limit = 20, opts) {
    return this.call("GET", this.teamPath("me", "requests") + `?limit=${limit}`, void 0, opts);
  }
  /**
   * M10-SPEC §2a: the Desktop OAuth client members use to connect Google Drive (read-only).
   * An installed-app client is not confidential (Google's rule); it is served to members so it
   * stays out of git. Not configured: 404 drive_not_configured.
   */
  driveClient(opts) {
    return this.call("GET", this.teamPath("drive-client"), void 0, opts);
  }
  /** M6-SPEC §2: the team's roster (owners see every email; members only their own). */
  roster(opts) {
    return this.call("GET", this.teamPath("roster"), void 0, opts);
  }
  /** M6-SPEC §2 (owners): add a member. Not idempotent, so sent once. */
  addMember(body, opts) {
    return this.call("POST", this.teamPath("roster"), body, { attempts: 1, ...opts });
  }
  /** M6-SPEC §2 (owners): add or remove one email, or change the role. Sent once. */
  updateMember(member, body, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call("PATCH", this.teamPath("roster", member), body, { attempts: 1, ...opts });
  }
  /** M6-SPEC §2 (owners): remove a member (their device credentials are revoked). Sent once. */
  removeMember(member, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call("DELETE", this.teamPath("roster", member), void 0, { attempts: 1, ...opts });
  }
  /** M5-SPEC §3: revoke the credential this client signs in with (logout). */
  revokeSelf(opts) {
    return this.call("DELETE", this.teamPath("credentials", "self"), void 0, { attempts: 1, ...opts });
  }
  // M9-SPEC §2, §4, §7: the account routes. They take a Google identity (a Google ID token,
  // or a delegate on behalf of an email); a device credential or a static token is refused
  // with 403 google_identity_required. The mutations are sent once.
  /** The teams (and invitations) of the signed-in Google account. */
  myTeams(opts) {
    return this.call("GET", "v1/me/teams", void 0, opts);
  }
  /** Create a team; the caller becomes its first owner. */
  createTeam(body, opts) {
    return this.call("POST", "v1/teams", body, { attempts: 1, ...opts });
  }
  /** Accept or decline an invitation to `team`. */
  answerInvitation(team, accept, opts) {
    if (!TEAM_RE.test(team)) throw new Error("invalid team id");
    return this.call("POST", ["v1", "me", "invitations", team].map(encodeURIComponent).join("/"), { accept }, {
      attempts: 1,
      ...opts
    });
  }
  /** An owner deletes this client's team (M9-SPEC §7.7); `confirm` is the team id typed again. */
  deleteTeam(confirm, opts) {
    return this.call("DELETE", ["v1", "teams", this.team].map(encodeURIComponent).join("/"), { confirm }, {
      attempts: 1,
      ...opts
    });
  }
  /** Relay admins (M9-SPEC §4): every team, a page at a time. */
  adminTeams(q = {}, opts) {
    const params = new URLSearchParams();
    if (q.after !== void 0) params.set("after", q.after);
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.call("GET", "v1/admin/teams" + (qs ? `?${qs}` : ""), void 0, opts);
  }
  /** Relay admins (M9-SPEC §4): delete a team; `confirm` is its id typed again. */
  adminDeleteTeam(team, confirm, opts) {
    if (!TEAM_RE.test(team)) throw new Error("invalid team id");
    return this.call("DELETE", ["v1", "admin", "teams", team].map(encodeURIComponent).join("/"), { confirm }, {
      attempts: 1,
      ...opts
    });
  }
  /** M2-SPEC §3.5: the team's activity feed. */
  activity(q = {}, opts) {
    const params = new URLSearchParams();
    if (q.since !== void 0) params.set("since", q.since);
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.call("GET", this.teamPath("activity") + (qs ? `?${qs}` : ""), void 0, opts);
  }
};
function relayClientFromEnv(env, extra = {}) {
  const c = connectionFromEnv(env);
  return new RelayClient({ url: c.url, team: c.team, token: c.token, ...extra });
}

// src/console-app.ts
var CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");
var SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8"
};
var TEAMS_TTL_MS = 15e3;
var TEAMS_CACHE_MAX = 1e3;
var RFC33392 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
var MY_REQUESTS_LIMIT = 20;
var TEAM_CLIENTS_MAX = 256;
function relayBackend(client) {
  const opts = (ctx) => ({
    attempts: 1,
    timeoutMs: 15e3,
    ...ctx?.viewer !== void 0 ? { onBehalfOf: ctx.viewer } : {}
  });
  const bound = client.boundToTeam;
  const clients = /* @__PURE__ */ new Map();
  const on = (ctx) => {
    const team = ctx?.team;
    if (team === void 0 || team === client.team) return client;
    let c = clients.get(team);
    if (!c) {
      if (clients.size >= TEAM_CLIENTS_MAX) clients.delete(clients.keys().next().value);
      c = client.withTeam(team);
      clients.set(team, c);
    }
    return c;
  };
  return {
    defaultTeam: client.team,
    fixedTeam: bound ? client.team : null,
    me: (ctx) => on(ctx).me(opts(ctx)),
    directory: (ctx) => on(ctx).directory(opts(ctx)),
    activity: (q, ctx) => on(ctx).activity(q, opts(ctx)),
    request: (id, ctx) => on(ctx).getRequest(id, opts(ctx)),
    roster: (ctx) => on(ctx).roster(opts(ctx)),
    inboxSummary: (ctx) => on(ctx).inboxSummary(opts(ctx)),
    addMember: (body, ctx) => on(ctx).addMember(body, opts(ctx)),
    updateMember: (member, body, ctx) => on(ctx).updateMember(member, body, opts(ctx)),
    removeMember: (member, ctx) => on(ctx).removeMember(member, opts(ctx)),
    myTeams: async (ctx) => {
      if (!bound) {
        try {
          return await client.myTeams(opts(ctx));
        } catch (err) {
          if (!(err instanceof RelayError && err.status === 403 && err.code === "google_identity_required")) throw err;
        }
      }
      return boundTeams(await client.me(opts(ctx)), client.team);
    },
    createTeam: (body, ctx) => client.createTeam(body, { ...opts(ctx), ...ctx?.clientIpHash !== void 0 ? { clientIpHash: ctx.clientIpHash } : {} }),
    answerInvitation: (team, accept, ctx) => client.answerInvitation(team, accept, opts(ctx)),
    deleteTeam: (confirm, ctx) => on(ctx).deleteTeam(confirm, opts(ctx)),
    adminTeams: (q, ctx) => client.adminTeams(q, opts(ctx)),
    adminDeleteTeam: (team, confirm, ctx) => client.adminDeleteTeam(team, confirm, opts(ctx)),
    boundaries: (ctx) => on(ctx).boundaries(opts(ctx)),
    setBoundaries: (body, ctx) => on(ctx).setBoundaries(body, opts(ctx)),
    acceptance: (ctx) => on(ctx).acceptance(opts(ctx)),
    setAcceptance: (version, ctx) => on(ctx).setAcceptance(version, opts(ctx)),
    membersStatus: (ctx) => on(ctx).membersStatus(opts(ctx)),
    myRequests: (limit, ctx) => on(ctx).myRequests(limit, opts(ctx)),
    // One key per question sent from the page: the console never retries it (attempts: 1).
    ask: (body, ctx) => on(ctx).createRequest({ idempotency_key: randomUUID(), kind: "question", to: body.to, question: body.question }, opts(ctx))
  };
}
function boundTeams(me, team) {
  const m = me && typeof me === "object" ? me : {};
  const member = typeof m.member === "string" ? m.member : null;
  return {
    teams: member ? [{ team, name: typeof m.name === "string" ? m.name : team, member, role: m.role === "owner" ? "owner" : "member" }] : [],
    invitations: [],
    admin: false,
    teams_created: null,
    max_teams_created: null,
    can_manage_teams: false
  };
}
function demoBackend(account) {
  return {
    defaultTeam: account.defaultTeam,
    fixedTeam: null,
    me: async (ctx) => account.team(ctx?.team).me(),
    directory: async (ctx) => account.team(ctx?.team).directory(),
    activity: async (q, ctx) => account.team(ctx?.team).activity(q),
    request: async (id, ctx) => account.team(ctx?.team).request(id),
    roster: async (ctx) => account.team(ctx?.team).roster(),
    inboxSummary: async (ctx) => account.team(ctx?.team).inboxSummary(),
    addMember: async (body, ctx) => account.team(ctx?.team).addMember(body),
    updateMember: async (member, body, ctx) => account.team(ctx?.team).updateMember(member, body),
    removeMember: async (member, ctx) => account.team(ctx?.team).removeMember(member),
    myTeams: async () => account.myTeams(),
    createTeam: async (body) => account.createTeam(body),
    answerInvitation: async (team, accept) => account.answerInvitation(team, accept),
    deleteTeam: async (confirm, ctx) => account.deleteTeam(ctx?.team ?? account.defaultTeam, confirm),
    adminTeams: async (q) => account.adminTeams(q),
    adminDeleteTeam: async (team, confirm) => account.adminDeleteTeam(team, confirm),
    boundaries: async (ctx) => account.team(ctx?.team).boundaries(),
    setBoundaries: async (body, ctx) => account.team(ctx?.team).setBoundaries(body),
    acceptance: async (ctx) => account.team(ctx?.team).acceptance(),
    setAcceptance: async (version, ctx) => account.team(ctx?.team).setAcceptance(version),
    membersStatus: async (ctx) => account.team(ctx?.team).membersStatus(),
    myRequests: async (limit, ctx) => account.team(ctx?.team).myRequests(limit),
    ask: async (body, ctx) => account.team(ctx?.team).ask(body)
  };
}
var ROSTER_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
var ROLES = ["owner", "member"];
var ROSTER_BODY_LIMIT = 4096;
var BodyError = class extends Error {
};
function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new BodyError(`unknown field ${k.slice(0, 40)}`);
}
function email(v, field) {
  if (typeof v !== "string") throw new BodyError(`${field} must be an email address`);
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !ROSTER_EMAIL_RE.test(e)) throw new BodyError(`${field} must be an email address`);
  return e;
}
function role(v) {
  if (typeof v !== "string" || !ROLES.includes(v)) throw new BodyError('role must be "owner" or "member"');
  return v;
}
function checkAddMember(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BodyError("the body must be a JSON object");
  const b = raw;
  onlyKeys(b, ["member", "email", "role"]);
  if (typeof b.member !== "string" || !MEMBER_RE.test(b.member)) {
    throw new BodyError("member must be 2 to 32 characters: a lower-case letter, then lower-case letters, digits or _");
  }
  const out = { member: b.member, email: email(b.email, "email") };
  if (b.role !== void 0) out.role = role(b.role);
  return out;
}
function checkUpdateMember(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BodyError("the body must be a JSON object");
  const b = raw;
  onlyKeys(b, ["add_email", "remove_email", "role"]);
  const out = {};
  if (b.add_email !== void 0) out.add_email = email(b.add_email, "add_email");
  if (b.remove_email !== void 0) out.remove_email = email(b.remove_email, "remove_email");
  if (b.role !== void 0) out.role = role(b.role);
  if (Object.keys(out).length === 0) throw new BodyError("nothing to change: give add_email, remove_email or role");
  return out;
}
var NEW_TEAM_ID_RE = /^[a-z][a-z0-9-]{2,31}$/;
var NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
function object(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BodyError("the body must be a JSON object");
  return raw;
}
function checkCreateTeam(raw) {
  const b = object(raw);
  onlyKeys(b, ["id", "name", "owner_member_id"]);
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if ([...name].length < 1 || [...name].length > 60 || NAME_FORBIDDEN_RE.test(name)) {
    throw new BodyError("name must be 1 to 60 characters, with no control or invisible characters");
  }
  if (typeof b.owner_member_id !== "string" || !MEMBER_RE.test(b.owner_member_id)) {
    throw new BodyError("owner_member_id must be 2 to 32 characters: a lower-case letter, then lower-case letters, digits or _");
  }
  const out = { name, owner_member_id: b.owner_member_id };
  if (b.id !== void 0) {
    if (typeof b.id !== "string" || !NEW_TEAM_ID_RE.test(b.id)) {
      throw new BodyError("id must be 3 to 32 characters: a lower-case letter, then lower-case letters, digits or -");
    }
    out.id = b.id;
  }
  return out;
}
function checkInvitationAnswer(raw) {
  const b = object(raw);
  onlyKeys(b, ["accept"]);
  if (typeof b.accept !== "boolean") throw new BodyError('send {"accept": true} or {"accept": false}');
  return b.accept;
}
function checkConfirm(raw, team) {
  const b = object(raw);
  onlyKeys(b, ["confirm"]);
  if (b.confirm !== team) throw new BodyError('type the team id to confirm: {"confirm": "<team id>"}');
  return team;
}
var BOUNDARIES_BODY_LIMIT = 32 * 1024;
function list(v, field, max, what) {
  if (!Array.isArray(v)) throw new BodyError(`${field} must be a list`);
  if (v.length > max) throw new BodyError(`at most ${max} ${what}`);
  return v;
}
function drive(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BodyError('each drive must be {"domain", "shared_drive"}');
  const d = v;
  onlyKeys(d, ["domain", "shared_drive"]);
  if (!domainOk(d.domain)) {
    throw new BodyError("a drive domain must be a lower-case domain name, such as example.com");
  }
  const name = d.shared_drive;
  if (!driveNameOk(name)) {
    throw new BodyError(
      `a shared drive name must be 1 to ${SHARED_DRIVE_MAX} characters, with no /, no control or invisible characters and no leading or trailing space`
    );
  }
  return { domain: d.domain, shared_drive: name };
}
function checkSetBoundaries(raw) {
  const b = object(raw);
  onlyKeys(b, ["version", "boundaries"]);
  if (!versionOk(b.version)) {
    throw new BodyError("version must be the whole number the boundaries were read at");
  }
  if (typeof b.boundaries !== "object" || b.boundaries === null || Array.isArray(b.boundaries)) {
    throw new BodyError('boundaries must be {"topic", "github_orgs", "drives", "member_folders"}');
  }
  const x = b.boundaries;
  onlyKeys(x, ["topic", "github_orgs", "drives", "member_folders"]);
  if (!topicOk(x.topic)) {
    throw new BodyError(`topic must be 1 to ${TOPIC_MAX} characters, with no control or invisible characters`);
  }
  const topic = trimText(x.topic);
  const orgs = [];
  for (const o of list(x.github_orgs, "github_orgs", BOUNDARIES_MAX_ORGS, "GitHub orgs")) {
    if (!orgOk(o)) {
      throw new BodyError("a GitHub org must be 1 to 39 letters, digits or -, not starting with -");
    }
    if (!orgs.some((have) => have.toLowerCase() === o.toLowerCase())) orgs.push(o);
  }
  const drives = [];
  for (const d of list(x.drives, "drives", BOUNDARIES_MAX_DRIVES, "shared drives").map(drive)) {
    if (!drives.some((have) => have.domain === d.domain && have.shared_drive === d.shared_drive)) drives.push(d);
  }
  if (typeof x.member_folders !== "boolean") throw new BodyError("member_folders must be true or false");
  const boundaries = { topic, github_orgs: orgs, drives, member_folders: x.member_folders };
  return { version: b.version, boundaries };
}
function checkAcceptance(raw) {
  const b = object(raw);
  onlyKeys(b, ["version"]);
  if (!versionOk(b.version)) throw new BodyError("version must be the whole number the boundaries were shown at");
  return b.version;
}
var ASK_MAX_RECIPIENTS = 64;
var QUESTION_MAX = 8e3;
var ASK_BODY_LIMIT = 128 * 1024;
function checkAsk(raw) {
  const b = object(raw);
  onlyKeys(b, ["to", "question"]);
  let to;
  if (b.to === "*") to = "*";
  else if (Array.isArray(b.to)) {
    if (b.to.length < 1 || b.to.length > ASK_MAX_RECIPIENTS) throw new BodyError(`to must name 1 to ${ASK_MAX_RECIPIENTS} teammates, or be "*"`);
    const seen = /* @__PURE__ */ new Set();
    for (const m of b.to) {
      if (typeof m !== "string" || !MEMBER_RE.test(m)) throw new BodyError("to must hold member ids");
      if (seen.has(m)) throw new BodyError("to names a member twice");
      seen.add(m);
    }
    to = [...seen];
  } else throw new BodyError('to must be a list of teammates or "*"');
  const q = b.question;
  if (typeof q !== "string" || q.length === 0 || codePointLength(q) > QUESTION_MAX) {
    throw new BodyError(`question must be 1 to ${QUESTION_MAX} characters`);
  }
  if (q.trim().length === 0) throw new BodyError("question must contain a character that is not white space");
  if (hasLoneSurrogate(q)) throw new BodyError("question contains a lone surrogate");
  return { to, question: q };
}
var count = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : null;
var displayName = (v, team) => typeof v === "string" && v.trim() !== "" && [...v].length <= 60 && !NAME_FORBIDDEN_RE.test(v) ? v : team;
var roleOf = (v) => v === "owner" ? "owner" : "member";
function parseTeams(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const list2 = (v) => Array.isArray(v) ? v.filter((x) => !!x && typeof x === "object" && !Array.isArray(x)).slice(0, 500) : [];
  const seen = /* @__PURE__ */ new Set();
  const teams = [];
  for (const t of list2(r.teams)) {
    if (typeof t.team !== "string" || !TEAM_RE.test(t.team) || typeof t.member !== "string" || !MEMBER_RE.test(t.member) || seen.has(t.team)) continue;
    seen.add(t.team);
    teams.push({ team: t.team, name: displayName(t.name, t.team), member: t.member, role: roleOf(t.role) });
  }
  const invitations = [];
  for (const t of list2(r.invitations)) {
    if (typeof t.team !== "string" || !TEAM_RE.test(t.team) || typeof t.member !== "string" || !MEMBER_RE.test(t.member) || seen.has(t.team)) continue;
    seen.add(t.team);
    invitations.push({
      team: t.team,
      name: displayName(t.name, t.team),
      member: t.member,
      role: roleOf(t.role),
      invited_by_member: typeof t.invited_by_member === "string" && MEMBER_RE.test(t.invited_by_member) ? t.invited_by_member : null
    });
  }
  return {
    teams,
    invitations,
    admin: r.admin === true,
    teams_created: count(r.teams_created),
    max_teams_created: count(r.max_teams_created),
    suggested_member: typeof r.suggested_member === "string" && MEMBER_RE.test(r.suggested_member) ? r.suggested_member : null,
    can_manage_teams: r.can_manage_teams !== false
  };
}
function clientAddress(req, hops = 1) {
  const raw = req.headers["x-forwarded-for"];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  const entries = (joined ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (hops === 2) return entries.length >= 2 ? entries[entries.length - 2] : "";
  return entries.at(-1) ?? req.socket.remoteAddress ?? "";
}
function isRunAppHost(publicHost) {
  return /^[^:]+\.run\.app(?::[0-9]{1,5})?$/.test(publicHost);
}
function checkProxyHops(raw, publicHost) {
  const v = raw?.trim();
  if (!v) {
    if (isRunAppHost(publicHost)) return 1;
    throw new Error(
      `CONSOLE_PROXY_HOPS must be set when the public host (${publicHost}) is not a run.app address: 2 behind the load balancer`
    );
  }
  if (v === "1") return 1;
  if (v === "2") return 2;
  throw new Error("CONSOLE_PROXY_HOPS must be 1 (Cloud Run) or 2 (behind the load balancer)");
}
function expandIpv6(a) {
  let addr = a;
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4) {
    const o = v4[2].split(".").map(Number);
    addr = `${v4[1]}${(o[0] << 8 | o[1]).toString(16)}:${(o[2] << 8 | o[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  return groups.length === 8 ? groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")) : null;
}
function addressKey(address) {
  let a = address.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(a);
  if (bracketed) a = bracketed[1];
  a = a.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1];
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind === 6) {
    const groups = expandIpv6(a);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : "unknown";
  }
  return "unknown";
}
function clientIpHash(salt, req, hops = 1) {
  return createHash2("sha256").update(salt + addressKey(clientAddress(req, hops)), "utf8").digest("hex");
}
function checkIpHashSalt(raw) {
  const v = raw?.trim();
  if (!v || v.length < 32 || v.length > 4096) throw new Error("CONSOLE_IP_HASH_SALT must be set to at least 32 characters");
  return v;
}
var JOIN_MARKETPLACE = "team-relay-dev";
var JOIN_PLUGIN = "team-relay";
var GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
function checkJoinMarketplace(raw) {
  const v = raw?.trim();
  if (!v) return null;
  if (GITHUB_REPO_RE.test(v) && !v.split("/").some((x) => x === "." || x === "..")) return v;
  try {
    return checkJoinRepoUrl(v);
  } catch {
    throw new Error("JOIN_MARKETPLACE must be a GitHub owner/repo or a plain https URL");
  }
}
function marketplaceFromRepoUrl(repoUrl) {
  if (!repoUrl) return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(repoUrl);
  return m ? `${m[1]}/${m[2]}` : repoUrl;
}
function joinInfo(relayUrl, team, repoUrl, marketplaceSource = null, defaultRelay = defaultRelayUrl()) {
  let isDefault = false;
  try {
    isDefault = defaultRelay !== null && normaliseRelayUrl(relayUrl) === normaliseRelayUrl(defaultRelay);
  } catch {
    isDefault = false;
  }
  return {
    relay_url: relayUrl,
    team,
    repo_url: repoUrl,
    marketplace_source: marketplaceSource ?? marketplaceFromRepoUrl(repoUrl),
    marketplace: JOIN_MARKETPLACE,
    plugin: JOIN_PLUGIN,
    default_relay: isDefault
  };
}
var DEMO_JOIN = joinInfo("https://relay.example.com", "demo", null, "example/team-relay", null);
var REPO_URL_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?(\/[A-Za-z0-9._~%+-]+)*\/?$/i;
function checkJoinRepoUrl(raw) {
  const v = raw?.trim();
  if (!v) return null;
  let url;
  try {
    url = new URL(v);
  } catch {
    throw new Error("JOIN_REPO_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("JOIN_REPO_URL must be an https URL");
  if (url.username || url.password) throw new Error("JOIN_REPO_URL must not carry credentials");
  if (url.search || url.hash || v.includes("?") || v.includes("#")) throw new Error("JOIN_REPO_URL must not carry a query or fragment");
  if (v.length > 512 || !REPO_URL_RE.test(v) || v.split("/").slice(3).some((seg) => seg === "." || seg === "..")) {
    throw new Error("JOIN_REPO_URL must be a plain https URL: a host and a path of letters, digits and ._~%+-");
  }
  return v;
}
var PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Team relay console</title></head>
<body>
<h1>Team relay console</h1>
<p>The console has not been built yet: <code>dist/console/</code> is missing. Build it from
<code>console/</code> (it builds into <code>plugin/dist/console/</code>), then reload this page.</p>
<p>The API is running: <code>/api/me</code>, <code>/api/directory</code>, <code>/api/activity</code>,
<code>/api/requests/{id}</code>, <code>/api/roster</code>, <code>/api/inbox/summary</code>, <code>/api/boundaries</code>, <code>/api/acceptance</code>,
<code>/api/members-status</code>, <code>/api/my-requests</code> and <code>/api/join</code>, with the key from this page's
address in an <code>X-Console-Key</code> header.</p>
</body>
</html>
`;
function digest(s) {
  return createHash2("sha256").update(s, "utf8").digest();
}
function keyMatches(given, key) {
  return timingSafeEqual(digest(given), digest(key));
}
var HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;
function checkPublicHost(raw) {
  const v = raw?.trim();
  if (!v) throw new Error("CONSOLE_PUBLIC_HOST must be set");
  if (v.length > 253 || !HOST_RE.test(v)) throw new Error("CONSOLE_PUBLIC_HOST must be a lower-case host name, without a scheme or path");
  return v;
}
function send(res, status, body, type, extra = {}, head = false) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(buf.length), ...extra });
  res.end(head ? void 0 : buf);
}
function sendJson(res, status, value, extra = {}) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extra });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => over ? reject(new Error("too large")) : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function headerValue(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? void 0 : v;
}
function createConsoleServer(opts) {
  const log2 = opts.log ?? (() => {
  });
  const hosted2 = opts.hosted ?? null;
  if (hosted2) {
    checkPublicHost(hosted2.publicHost);
    checkIpHashSalt(hosted2.ipHashSalt);
  } else if (typeof opts.key !== "string" || opts.key === "") throw new Error("a console key is required in local mode");
  let port = -1;
  let staticRoot = null;
  try {
    if (statSync(opts.staticDir).isDirectory()) staticRoot = realpathSync(opts.staticDir);
  } catch {
    staticRoot = null;
  }
  function hostAllowed(req) {
    const host = headerValue(req, "host")?.toLowerCase();
    if (hosted2) return host === hosted2.publicHost;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }
  const now = opts.now ?? Date.now;
  const teamsCache = /* @__PURE__ */ new Map();
  function viewerTeams(ctx, fresh = false) {
    const key = ctx.viewer ?? "";
    const hit = teamsCache.get(key);
    if (hit && !fresh && now() - hit.at < TEAMS_TTL_MS) return hit.view;
    const view = opts.backend.myTeams(ctx.viewer !== void 0 ? { viewer: ctx.viewer } : {}).then(parseTeams);
    if (teamsCache.size >= TEAMS_CACHE_MAX && !teamsCache.has(key)) teamsCache.delete(teamsCache.keys().next().value);
    const entry = { at: now(), view };
    teamsCache.set(key, entry);
    view.catch(() => {
      if (teamsCache.get(key) === entry) teamsCache.delete(key);
    });
    return view;
  }
  function forgetTeams(viewer) {
    teamsCache.delete(viewer ?? "");
  }
  function notOnTeam(res, viewer, team) {
    sendJson(res, 403, { error: "not_on_team", ...hosted2 && viewer !== void 0 ? { email: viewer } : {}, team });
  }
  async function resolveTeam(req, res, url, ctx) {
    const asked = askedTeam(req, res, url);
    if (asked === null) return null;
    const team = asked === void 0 ? opts.backend.defaultTeam : asked;
    const fixed = opts.backend.fixedTeam;
    if (fixed !== null) {
      if (team !== fixed) {
        notOnTeam(res, ctx.viewer, team);
        return null;
      }
      return team;
    }
    let view;
    try {
      view = await viewerTeams(ctx);
    } catch (err) {
      failure(res, err, ctx.viewer);
      return null;
    }
    if (!view.teams.some((t) => t.team === team)) {
      notOnTeam(res, ctx.viewer, team);
      return null;
    }
    return team;
  }
  function askedTeam(req, res, url) {
    const fromQuery = url.searchParams.getAll("team");
    const header = req.headers["x-relay-team"];
    if (fromQuery.length > 1 || Array.isArray(header)) {
      sendJson(res, 400, { error: "bad_request", detail: "name the team once" });
      return null;
    }
    const q = fromQuery[0];
    if (q !== void 0 && header !== void 0 && q !== header) {
      sendJson(res, 400, { error: "bad_request", detail: "the team parameter and X-Relay-Team differ" });
      return null;
    }
    const asked = q ?? header;
    if (asked !== void 0 && !TEAM_RE.test(asked)) {
      sendJson(res, 400, { error: "bad_request", detail: "team must be a team id" });
      return null;
    }
    return asked;
  }
  function failure(res, err, viewer, team) {
    if (err instanceof RelayError && err.status === 403 && err.code === "not_a_member") {
      forgetTeams(viewer);
      return notOnTeam(res, viewer, team ?? opts.backend.defaultTeam);
    }
    if (team !== void 0 && (err instanceof NotFound || err instanceof RelayError && err.status === 404)) {
      forgetTeams(viewer);
      return notOnTeam(res, viewer, team);
    }
    if (err instanceof NotFound || err instanceof RelayError && err.status === 404) return sendJson(res, 404, { error: "not_found" });
    if (err instanceof BadRequest) return sendJson(res, 400, { error: "bad_request", detail: err.detail });
    if (err instanceof RosterRefusal) {
      return sendJson(res, 502, { error: "relay_refused", relay_status: err.status, relay_error: err.code, detail: err.detail });
    }
    if (err instanceof RelayError) {
      return sendJson(res, 502, {
        error: "relay_refused",
        relay_status: err.status,
        relay_error: err.code,
        ...err.detail ? { detail: err.detail.slice(0, 300) } : {}
      });
    }
    if (err instanceof RelayNetworkError) return sendJson(res, 502, { error: "relay_unreachable", detail: err.message });
    const detail = err instanceof Error ? err.message.slice(0, 300) : "unexpected error";
    return sendJson(res, 502, { error: "relay_unavailable", detail });
  }
  function changeRoute(path) {
    if (path === "/api/roster") return { methods: ["POST"], kind: "roster", id: null };
    if (path === "/api/boundaries") return { methods: ["PUT"], kind: "boundaries", id: null };
    if (path === "/api/acceptance") return { methods: ["PUT"], kind: "acceptance", id: null };
    if (path === "/api/ask") return { methods: ["POST"], kind: "ask", id: null };
    let m = /^\/api\/roster\/([^/]+)$/.exec(path);
    if (m) return { methods: ["PATCH", "DELETE"], kind: "roster_one", id: m[1] };
    if (path === "/api/teams") return { methods: ["POST"], kind: "teams", id: null };
    m = /^\/api\/teams\/([^/]+)$/.exec(path);
    if (m) return { methods: ["DELETE"], kind: "team", id: m[1] };
    m = /^\/api\/invitations\/([^/]+)$/.exec(path);
    if (m) return { methods: ["POST"], kind: "invitation", id: m[1] };
    m = /^\/api\/admin\/teams\/([^/]+)$/.exec(path);
    if (m) return { methods: ["DELETE"], kind: "admin_team", id: m[1] };
    return null;
  }
  async function change(req, res, url, ctx, route2) {
    const method = req.method ?? "";
    const reads = route2.kind === "teams" || route2.kind === "roster" || route2.kind === "boundaries" || route2.kind === "acceptance" ? ["GET"] : [];
    if (!route2.methods.includes(method)) {
      req.resume();
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: [...reads, ...route2.methods].join(", ") });
    }
    if (headerValue(req, "sec-fetch-site") !== "same-origin") {
      req.resume();
      return sendJson(res, 403, { error: "forbidden", detail: "Sec-Fetch-Site: same-origin is required" });
    }
    const type = headerValue(req, "content-type") ?? "";
    if (!/^application\/json\s*(;.*)?$/i.test(type)) {
      req.resume();
      return sendJson(res, 415, { error: "unsupported_media_type", detail: "Content-Type must be application/json" });
    }
    const teamScoped = route2.kind === "roster" || route2.kind === "roster_one" || route2.kind === "boundaries" || route2.kind === "acceptance" || route2.kind === "ask";
    const extra = [...url.searchParams.keys()].filter((k) => !(teamScoped && k === "team"));
    if (extra.length > 0) {
      req.resume();
      return sendJson(res, 400, { error: "bad_request", detail: "no query parameters here" });
    }
    const id = route2.id;
    const idOk = id === null || (route2.kind === "roster_one" ? MEMBER_RE.test(id) : TEAM_RE.test(id));
    if (!idOk) {
      req.resume();
      return sendJson(res, 404, { error: "not_found" });
    }
    const limit = route2.kind === "boundaries" ? BOUNDARIES_BODY_LIMIT : route2.kind === "ask" ? ASK_BODY_LIMIT : ROSTER_BODY_LIMIT;
    let text;
    try {
      text = await readBody(req, limit);
    } catch {
      return sendJson(res, 413, { error: "too_large", detail: `at most ${limit} bytes` });
    }
    let raw = void 0;
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return sendJson(res, 400, { error: "bad_request", detail: "the body is not JSON" });
      }
    }
    const viewer = ctx.viewer;
    const who = viewer !== void 0 ? { viewer } : {};
    let call;
    let status = 200;
    let what;
    let team;
    try {
      switch (route2.kind) {
        case "roster":
        case "roster_one": {
          let body;
          if (method === "POST") body = checkAddMember(raw);
          else if (method === "PATCH") body = checkUpdateMember(raw);
          else if (raw !== void 0 && (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0)) {
            throw new BodyError("a removal takes no body");
          }
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          const on = { ...who, team: resolved };
          if (method === "POST") {
            status = 201;
            call = () => opts.backend.addMember(body, on);
          } else if (method === "PATCH") call = () => opts.backend.updateMember(id, body, on);
          else call = () => opts.backend.removeMember(id, on);
          what = `roster ${method === "POST" ? "add" : method === "PATCH" ? "update" : "remove"}${id ? ` ${id}` : ""} (team ${resolved})`;
          break;
        }
        case "boundaries": {
          const body = checkSetBoundaries(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          call = () => opts.backend.setBoundaries(body, { ...who, team: resolved });
          what = `boundaries set from version ${body.version} (team ${resolved})`;
          break;
        }
        case "acceptance": {
          const version = checkAcceptance(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          call = () => opts.backend.setAcceptance(version, { ...who, team: resolved });
          what = `boundaries accepted at version ${version} (team ${resolved})`;
          break;
        }
        case "ask": {
          const body = checkAsk(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          status = 201;
          call = () => opts.backend.ask(body, { ...who, team: resolved });
          what = `question asked of ${body.to === "*" ? "everyone" : `${body.to.length} ${body.to.length === 1 ? "member" : "members"}`} (team ${resolved})`;
          break;
        }
        case "teams": {
          const body = checkCreateTeam(raw);
          const ipHash = hosted2 ? { clientIpHash: clientIpHash(hosted2.ipHashSalt, req, hosted2.proxyHops ?? 1) } : {};
          status = 201;
          call = () => opts.backend.createTeam(body, { ...who, ...ipHash });
          what = "team create";
          break;
        }
        case "invitation": {
          const accept = checkInvitationAnswer(raw);
          call = () => opts.backend.answerInvitation(id, accept, who);
          what = `invitation ${accept ? "accept" : "decline"} (team ${id})`;
          break;
        }
        case "team": {
          const confirm = checkConfirm(raw, id);
          url.searchParams.set("team", id);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          call = () => opts.backend.deleteTeam(confirm, { ...who, team: resolved });
          what = `team delete (team ${id})`;
          break;
        }
        case "admin_team": {
          const confirm = checkConfirm(raw, id);
          call = () => opts.backend.adminDeleteTeam(id, confirm, who);
          what = `admin team delete (team ${id})`;
          break;
        }
      }
    } catch (err) {
      return sendJson(res, 400, { error: "bad_request", detail: err instanceof BodyError ? err.message : "bad body" });
    }
    log2(what);
    try {
      const out = await call();
      if (!teamScoped) forgetTeams(viewer);
      return sendJson(res, status, out);
    } catch (err) {
      if (!teamScoped) forgetTeams(viewer);
      const aboutTeam = route2.kind === "roster" || route2.kind === "boundaries" || route2.kind === "acceptance" || route2.kind === "ask";
      if (team !== void 0 && aboutTeam && err instanceof RelayError && err.status === 404) return failure(res, err, viewer, team);
      return failure(res, err, viewer);
    }
  }
  async function api(req, res, url, viewer) {
    const site = headerValue(req, "sec-fetch-site");
    if (site !== void 0 && site !== "same-origin" && site !== "none") {
      req.resume();
      return sendJson(res, 403, { error: "forbidden", detail: "cross-site request" });
    }
    if (!hosted2) {
      const given = headerValue(req, "x-console-key");
      if (given === void 0 || given === "") {
        req.resume();
        return sendJson(res, 401, { error: "unauthenticated", detail: "X-Console-Key is required" });
      }
      if (!keyMatches(given, opts.key)) {
        req.resume();
        return sendJson(res, 403, { error: "forbidden", detail: "wrong console key" });
      }
    }
    const ctx = viewer !== void 0 ? { viewer } : {};
    const path = url.pathname;
    const route2 = changeRoute(path);
    if (req.method !== "GET") {
      if (route2) return change(req, res, url, ctx, route2);
      req.resume();
      return sendJson(res, 405, { error: "method_not_allowed", detail: "the console is read-only" }, { Allow: "GET" });
    }
    req.resume();
    const query = [...url.searchParams.keys()];
    if (path === "/api/approvals/summary") {
      if (query.length > 0) return sendJson(res, 400, { error: "bad_request", detail: "no query parameters here" });
      if (hosted2 || !opts.approvals) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, opts.approvals());
    }
    if (path === "/api/teams") {
      if (query.length > 0) return sendJson(res, 400, { error: "bad_request", detail: "no query parameters here" });
      let view;
      try {
        view = opts.backend.fixedTeam !== null ? parseTeams(await opts.backend.myTeams(ctx)) : await viewerTeams(ctx, true);
      } catch (err) {
        return failure(res, err, viewer);
      }
      return sendJson(res, 200, {
        ...view,
        default_team: opts.backend.defaultTeam,
        // Hosted, the viewer's own IAP-verified email, for the not-on-team page; theirs only.
        ...hosted2 && viewer !== void 0 ? { email: viewer } : {}
      });
    }
    if (path === "/api/admin/teams") {
      const q2 = {};
      for (const k of query) {
        if (k !== "after" && k !== "limit") return sendJson(res, 400, { error: "bad_request", detail: `unknown parameter ${k.slice(0, 40)}` });
      }
      if (url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) {
        return sendJson(res, 400, { error: "bad_request", detail: "repeated parameter" });
      }
      const after = url.searchParams.get("after");
      if (after !== null) {
        if (!TEAM_RE.test(after)) return sendJson(res, 400, { error: "bad_request", detail: "after must be a team id" });
        q2.after = after;
      }
      const limit = url.searchParams.get("limit");
      if (limit !== null) {
        if (!/^[0-9]{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > 1e3) {
          return sendJson(res, 400, { error: "bad_request", detail: "limit must be 1..1000" });
        }
        q2.limit = Number(limit);
      }
      try {
        return sendJson(res, 200, await opts.backend.adminTeams(q2, ctx));
      } catch (err) {
        return failure(res, err, viewer);
      }
    }
    const own = query.filter((k) => k !== "team");
    const known = path === "/api/join" || path === "/api/me" || path === "/api/directory" || path === "/api/roster" || path === "/api/inbox/summary" || path === "/api/boundaries" || path === "/api/acceptance" || path === "/api/members-status" || path === "/api/my-requests";
    const requestMatch = /^\/api\/requests\/([^/]+)$/.exec(path);
    if (!known && path !== "/api/activity" && !requestMatch) return sendJson(res, 404, { error: "not_found" });
    if (requestMatch && (!REQUEST_ID_RE.test(requestMatch[1]) || own.length > 0)) return sendJson(res, 404, { error: "not_found" });
    if (known && own.length > 0) return sendJson(res, 400, { error: "bad_request", detail: "no query parameters here" });
    const q = {};
    if (path === "/api/activity") {
      for (const k of own) {
        if (k !== "since" && k !== "limit") return sendJson(res, 400, { error: "bad_request", detail: `unknown parameter ${k.slice(0, 40)}` });
      }
      if (url.searchParams.getAll("since").length > 1 || url.searchParams.getAll("limit").length > 1) {
        return sendJson(res, 400, { error: "bad_request", detail: "repeated parameter" });
      }
      const since = url.searchParams.get("since");
      if (since !== null) {
        if (!RFC33392.test(since)) return sendJson(res, 400, { error: "bad_request", detail: "since must be an RFC 3339 time" });
        q.since = since;
      }
      const limit = url.searchParams.get("limit");
      if (limit !== null) {
        if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
          return sendJson(res, 400, { error: "bad_request", detail: "limit must be 1..200" });
        }
        q.limit = Number(limit);
      }
    }
    if (path === "/api/join" && !hosted2) {
      const asked = askedTeam(req, res, url);
      if (asked === null) return;
      if (!opts.join) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { ...opts.join, team: asked ?? opts.join.team });
    }
    const team = await resolveTeam(req, res, url, ctx);
    if (team === null) return;
    const on = { ...ctx, team };
    if (path === "/api/join") {
      if (!opts.join) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { ...opts.join, team });
    }
    let call;
    if (path === "/api/me") {
      call = async () => {
        const me = await opts.backend.me(on);
        return on.viewer !== void 0 && me !== null && typeof me === "object" && !Array.isArray(me) ? { ...me, email: on.viewer } : me;
      };
    } else if (path === "/api/directory") call = () => opts.backend.directory(on);
    else if (path === "/api/inbox/summary") call = () => opts.backend.inboxSummary(on);
    else if (path === "/api/roster") call = () => opts.backend.roster(on);
    else if (path === "/api/boundaries") call = () => opts.backend.boundaries(on);
    else if (path === "/api/acceptance") call = () => opts.backend.acceptance(on);
    else if (path === "/api/members-status") call = () => opts.backend.membersStatus(on);
    else if (path === "/api/my-requests") call = () => opts.backend.myRequests(MY_REQUESTS_LIMIT, on);
    else if (path === "/api/activity") call = () => opts.backend.activity(q, on);
    else {
      const rid = requestMatch[1];
      call = () => opts.backend.request(rid, on);
    }
    try {
      return sendJson(res, 200, await call());
    } catch (err) {
      const newer = path === "/api/boundaries" || path === "/api/acceptance" || path === "/api/members-status" || path === "/api/my-requests";
      return failure(res, err, viewer, requestMatch || newer ? void 0 : team);
    }
  }
  function staticFile(req, res, url) {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return send(res, 405, "method not allowed\n", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
    const html = (body) => send(res, 200, body, MIME[".html"], { "Cache-Control": "no-cache" }, head);
    const index = staticRoot ? join2(staticRoot, "index.html") : null;
    if (!staticRoot || !index || !existsSync(index)) return html(PLACEHOLDER);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "bad path\n", "text/plain; charset=utf-8");
    }
    if (rel.includes("\0") || rel.includes("\\") || rel.split("/").some((seg) => seg === ".." || seg === ".")) {
      return send(res, 400, "bad path\n", "text/plain; charset=utf-8");
    }
    if (rel === "/" || rel === "") return html(readFileSync5(index));
    const candidate = join2(staticRoot, rel);
    let real = null;
    try {
      real = realpathSync(candidate);
    } catch {
      real = null;
    }
    if (real && real.startsWith(staticRoot + sep) && statSync(real).isFile()) {
      const type = MIME[extname(real).toLowerCase()] ?? "application/octet-stream";
      const cache2 = rel.startsWith("/assets/") ? `${hosted2 ? "private" : "public"}, max-age=31536000, immutable` : "no-cache";
      return send(res, 200, readFileSync5(real), type, { "Cache-Control": cache2 }, head);
    }
    if (!extname(rel)) return html(readFileSync5(index));
    return send(res, 404, "not found\n", "text/plain; charset=utf-8");
  }
  const unauthorized = (res) => send(res, 401, "unauthorized\n", "text/plain; charset=utf-8", { "Cache-Control": "no-store" });
  const server = createServer((req, res) => {
    if (!hostAllowed(req)) {
      req.resume();
      send(res, 403, "forbidden host\n", "text/plain; charset=utf-8");
      return;
    }
    if (!hosted2) {
      route(req, res, void 0);
      return;
    }
    const assertion = req.headers[IAP_HEADER];
    hosted2.verify(Array.isArray(assertion) ? void 0 : assertion).then(
      (identity) => {
        if (!identity) {
          req.resume();
          return unauthorized(res);
        }
        route(req, res, identity.email);
      },
      () => {
        log2("iap: verification error");
        req.resume();
        if (!res.headersSent) unauthorized(res);
      }
    );
  });
  function route(req, res, viewer) {
    let url;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      req.resume();
      send(res, 400, "bad request\n", "text/plain; charset=utf-8");
      return;
    }
    const rawPath = (req.url ?? "").split("?")[0];
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (!isApi) req.resume();
    if (!rawPath?.startsWith("/") || rawPath !== url.pathname) {
      req.resume();
      send(res, 400, "bad path\n", "text/plain; charset=utf-8");
      return;
    }
    if (isApi) {
      api(req, res, url, viewer).catch((err) => {
        log2(`api error: ${err instanceof Error ? err.message : "unexpected"}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      });
      return;
    }
    try {
      staticFile(req, res, url);
    } catch {
      if (!res.headersSent) send(res, 500, "internal error\n", "text/plain; charset=utf-8");
    }
  }
  server.requestTimeout = 3e4;
  server.headersTimeout = 1e4;
  return {
    server,
    listen: (p) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, hosted2 ? "0.0.0.0" : "127.0.0.1", () => {
        server.off("error", reject);
        port = server.address().port;
        resolve(port);
      });
    }),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

// src/console-open.ts
import { execFile as execFile2 } from "node:child_process";
import { chmodSync as chmodSync2, mkdtempSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute2, join as join3 } from "node:path";
var REDIRECT_TTL_MS = 1e4;
var REDIRECT_FILE = "console.html";
var defaultRun = (command, args, done) => {
  execFile2(command, args, { shell: false, timeout: 1e4 }, (err) => done(err));
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function redirectHtml(url, title = "Team console") {
  const u = escapeHtml(url);
  const t = escapeHtml(title);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${u}">`,
    `<title>${t}</title></head>`,
    `<body><p><a href="${u}">${t}</a></p></body></html>`,
    ""
  ].join("\n");
}
function openerFor(platform, env = process.env) {
  const custom = env.TEAM_RELAY_OPEN_COMMAND?.trim();
  if (custom) return isAbsolute2(custom) ? custom : null;
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  return null;
}
function openInBrowser(url, opts) {
  const what = opts.what ?? "the URL above";
  const opener = opts.opener ?? openerFor(opts.platform ?? process.platform);
  if (!opener) {
    opts.log(`no browser opener on this platform; open ${what} yourself`);
    return null;
  }
  let dir;
  try {
    dir = mkdtempSync(join3(opts.tmpRoot ?? tmpdir(), "team-relay-console-"));
    chmodSync2(dir, 448);
  } catch {
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    return null;
  }
  const cleanup = () => rmSync2(dir, { recursive: true, force: true });
  const file = join3(dir, REDIRECT_FILE);
  try {
    writeFileSync(file, redirectHtml(url, opts.title), { mode: 384, flag: "wx" });
  } catch {
    cleanup();
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    return null;
  }
  process.once("exit", cleanup);
  setTimeout(() => {
    process.removeListener("exit", cleanup);
    cleanup();
  }, opts.deleteAfterMs ?? REDIRECT_TTL_MS).unref();
  (opts.run ?? defaultRun)(opener, [file], (err) => {
    if (err) opts.log(`could not open a browser (${opener}); open ${what} yourself`);
  });
  return file;
}

// src/approvals-state.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync6, renameSync as renameSync2, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/answering-lock.ts
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolute3, join as join4 } from "node:path";
function configDir(env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute3(xdg) ? xdg : join4(env.HOME?.trim() || homedir2(), ".config");
  return join4(base, "team-relay");
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// src/approvals-state.ts
var STATE_FILE = "approvals.json";
function statePath(env) {
  return join5(configDir(env), STATE_FILE);
}
function readApprovalsState(path, alive = pidAlive) {
  let raw;
  try {
    raw = readFileSync6(path, "utf8");
  } catch {
    return null;
  }
  if (raw.length > 4096) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v.pending !== "number" || !Number.isInteger(v.pending) || v.pending < 0 || v.pending > 1e4) return null;
    if (typeof v.pid !== "number" || !alive(v.pid)) return null;
    return { pending: v.pending, pid: v.pid, updated_at: typeof v.updated_at === "string" ? v.updated_at : "" };
  } catch {
    return null;
  }
}

// src/log.ts
function makeLogger(component) {
  return (...parts) => {
    const text = parts.map((p) => p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p)).join(" ");
    process.stderr.write(`[team-relay ${component}] ${text}
`);
  };
}

// src/tool-util.ts
function describeError(err) {
  if (err instanceof RelayError) {
    return `relay refused (${err.status} ${err.code})${err.detail ? `: ${err.detail}` : ""}`;
  }
  if (err instanceof RelayNetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return "unexpected error";
}

// src/console-server.ts
var log = makeLogger("console");
var DEFAULT_PORT = 4317;
var USAGE = `usage: bin/console [--demo] [--open]
  --demo  serve synthetic teams (demo: alice, bob, carol) instead of calling the relay
  --open  open the console in the default browser (by way of a private, short-lived file)
Signs in as you with the credential /team-relay:login stored; nothing else is needed.
Environment: CONSOLE_PORT (default ${DEFAULT_PORT}; 0 picks a free port), and optionally
RELAY_URL, RELAY_TEAM, RELAY_AUTH (credential|google|token), RELAY_GCLOUD_ACCOUNT, RELAY_TOKEN_FILE or RELAY_TOKEN.
JOIN_MARKETPLACE (optional; GitHub owner/repo or https URL) and JOIN_REPO_URL (optional, https):
what the join panel tells new members to add as a plugin marketplace.
CONSOLE_MODE=hosted is for the container only (PORT, CONSOLE_PUBLIC_HOST, IAP_AUDIENCE,
CONSOLE_IP_HASH_SALT, CONSOLE_PROXY_HOPS, RELAY_URL, RELAY_TEAM, RELAY_AUTH=metadata, JOIN_MARKETPLACE,
JOIN_REPO_URL).`;
function fail(message2, code = 1) {
  process.stderr.write(`console: ${message2}
`);
  process.exit(code);
}
function parseArgs(argv) {
  const flags = { demo: false, open: false };
  for (const a of argv) {
    if (a === "--demo") flags.demo = true;
    else if (a === "--open") flags.open = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}
`);
      process.exit(0);
    } else fail(`unknown argument: ${a.slice(0, 60)}
${USAGE}`, 2);
  }
  return flags;
}
function parsePort(raw) {
  if (raw === void 0 || raw === "") return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) > 65535) fail("CONSOLE_PORT must be an integer from 0 to 65535");
  return Number(raw);
}
function parseHostedPort(raw) {
  if (raw === void 0 || raw === "") return 8080;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) fail("PORT must be an integer from 1 to 65535");
  return Number(raw);
}
async function hosted() {
  const args = process.argv.slice(2);
  if (args.length > 0) fail("CONSOLE_MODE=hosted takes no arguments", 2);
  const env = process.env;
  const port = parseHostedPort(env.PORT);
  let publicHost;
  let audience;
  let backend;
  let team;
  let join6;
  let ipHashSalt;
  let proxyHops;
  try {
    const repoUrl = checkJoinRepoUrl(env.JOIN_REPO_URL);
    const marketplace = checkJoinMarketplace(env.JOIN_MARKETPLACE);
    publicHost = checkPublicHost(configValue(env.CONSOLE_PUBLIC_HOST));
    audience = checkIapAudience(configValue(env.IAP_AUDIENCE));
    ipHashSalt = checkIpHashSalt(env.CONSOLE_IP_HASH_SALT);
    proxyHops = checkProxyHops(env.CONSOLE_PROXY_HOPS, publicHost);
    if (authModeFromEnv(env) !== "metadata") throw new Error("CONSOLE_MODE=hosted needs RELAY_AUTH=metadata");
    const client = relayClientFromEnv(env);
    backend = relayBackend(client);
    team = client.team;
    join6 = joinInfo(configValue(env.RELAY_URL) ?? "", team, repoUrl, marketplace);
  } catch (err) {
    fail(`configuration error: ${describeError(err)}`);
  }
  const keys = new IapKeySet({ log });
  const verify = iapVerifier({ audience, keys, log });
  const staticDir = fileURLToPath3(new URL("./console/", import.meta.url));
  const app = createConsoleServer({ backend, hosted: { publicHost, verify, ipHashSalt, proxyHops }, staticDir, join: join6, log });
  let bound;
  try {
    bound = await app.listen(port);
  } catch (err) {
    fail(`cannot listen on 0.0.0.0:${port} (${err.code ?? describeError(err)})`);
  }
  log(
    `hosted: serving the viewer's teams (default ${team}) for ${publicHost} on 0.0.0.0:${bound}, behind IAP${proxyHops === 2 ? " on the load balancer" : ""}`
  );
  const stop = () => {
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2e3).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
async function main() {
  const mode = configValue(process.env.CONSOLE_MODE) ?? "local";
  if (mode === "hosted") return hosted();
  if (mode !== "local") fail('CONSOLE_MODE must be "local" or "hosted"', 2);
  const flags = parseArgs(process.argv.slice(2));
  const port = parsePort(process.env.CONSOLE_PORT);
  let repoUrl;
  let marketplace;
  try {
    repoUrl = checkJoinRepoUrl(process.env.JOIN_REPO_URL);
    marketplace = checkJoinMarketplace(process.env.JOIN_MARKETPLACE);
  } catch (err) {
    fail(`configuration error: ${describeError(err)}`);
  }
  let backend;
  let label;
  let join6;
  if (flags.demo) {
    backend = demoBackend(new DemoAccount());
    label = "demo teams (synthetic: alice, bob, carol)";
    join6 = DEMO_JOIN;
  } else {
    let client;
    try {
      client = relayClientFromEnv(process.env);
    } catch (err) {
      if (err instanceof NotConnected) fail("not signed in: run /team-relay:login in Claude Code first (or run with --demo)");
      fail(`configuration error: ${describeError(err)} (or run with --demo)`);
    }
    backend = relayBackend(client);
    label = `team ${client.team}`;
    join6 = joinInfo(client.url, client.team, repoUrl, marketplace);
  }
  const key = randomBytes(32).toString("base64url");
  const staticDir = fileURLToPath3(new URL("./console/", import.meta.url));
  const approvals = flags.demo ? void 0 : () => ({ pending: readApprovalsState(statePath(process.env))?.pending ?? 0 });
  const app = createConsoleServer({ backend, key, staticDir, join: join6, log, ...approvals ? { approvals } : {} });
  let bound;
  try {
    bound = await app.listen(port);
  } catch (err) {
    fail(`cannot listen on 127.0.0.1:${port} (${err.code ?? describeError(err)})`);
  }
  const url = `http://127.0.0.1:${bound}/#k=${key}`;
  log(`serving ${label} on 127.0.0.1:${bound}; stop with Ctrl-C`);
  process.stdout.write(`${url}
`);
  if (flags.open) openInBrowser(url, { log });
  if (!flags.demo) {
    backend.me().then(
      () => log("the relay answered"),
      (err) => log(`the relay did not answer yet (${describeError(err)}); the console will show it as unreachable`)
    );
  }
  const stop = () => {
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2e3).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
main().catch((err) => fail(`fatal: ${describeError(err)}`));
