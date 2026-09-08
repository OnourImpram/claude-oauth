// Clodex local patch: injects this system's OAuth-only external models into the
// Claude shadow binary's model surface (Zod enum, alias resolver, alias validator,
// /model picker rows, context-window table).
//
// The patch id still says "google" because it is the marker string that identifies
// an already-patched binary; renaming it would orphan every installed shadow. The
// patch itself covers Google AND xAI lanes -- see externalModels below.
//
// Every row here is derived from src/domain/model-contracts.ts. If the two drift,
// the picker offers a model the router will refuse with unknown_model.

const externalModels = Object.freeze([
  Object.freeze({
    alias: "gemini",
    label: "Gemini",
    description: "Gemini 3.8 Flash High (Google OAuth, 1M context)",
    fullId: "anthropic-google-gemini-3.8-flash-high",
    contextWindow: 1_048_576,
  }),
  Object.freeze({
    alias: "gemini-pro",
    label: "Gemini Pro",
    description: "Gemini 3.1 Pro High (Google OAuth, 1M context)",
    fullId: "anthropic-google-gemini-3.1-pro-high",
    contextWindow: 1_048_576,
  }),
  Object.freeze({
    alias: "opus-google",
    label: "Opus Google",
    description: "Claude Opus 4.6 Thinking (Google OAuth, 1M context)",
    fullId: "anthropic-google-claude-opus-4-6-thinking",
    contextWindow: 1_048_576,
  }),
  Object.freeze({
    alias: "grok",
    label: "Grok",
    description: "Grok 4.6 (xAI OAuth, 500K context)",
    fullId: "anthropic-xai-grok-4.6",
    contextWindow: 500_000,
  }),
]);

// The old name (`replaceExactly`) promised a check it never made: it added the `g` flag
// and called String.replace, counting nothing. Two matches meant two injections.
//
// MEASURED 2026-09-05 (independent audit, BULGU 4): a source carrying two clodex-shaped
// picker arrays drove all four picker needles to x2, and verifyShadowModelSurface then
// rejects the binary with a needle count and no cause. Exposure was low -- clodex's own
// applyOnce refuses a pattern that matches more than once -- but the picker anchor was
// deliberately WIDENED on the same day (it no longer pins the first row to Sol), and a
// widened anchor with no count is a loaded gun pointed at a later Claude build.
//
// The count is now the contract:
//   0  -> the anchor is absent; return the source untouched. That is the negative arm --
//         a binary clodex never patched must NOT receive picker/resolver rows.
//   1  -> replace it.
//   >1 -> AMBIGUOUS: throw. Failing the patch loudly beats shipping a doubled picker
//         that fails verification later for reasons the message cannot explain.
//
// The Zod enum anchor deliberately does NOT go through this helper: one Claude build can
// legitimately carry the same model-enum shape in several schemas and every one of them
// has to learn the new aliases. That call keeps the global replace, on purpose.
function replaceUniqueAnchor(name, source, pattern, replacement) {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const count = (source.match(globalPattern) ?? []).length;
  if (count === 0) return source;
  if (count > 1) {
    throw new Error(
      `hezarfen local patch: anchor "${name}" matched ${count} times, refusing to inject twice. ` +
      `ONARIM: tighten this anchor for the current Claude build (config/claude-oauth-local-patches.mjs), ` +
      `then repatch -- a doubled injection would surface later as verifyShadowModelSurface needle xN.`
    );
  }
  return source.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
}

export default [
  {
    id: "hezarfen-google-oauth-model-surface",
    apply(source, { marker }) {
      if (source.includes(marker)) return source;

      let next = source;
      let zodStash = "";

      const zAnchor = /((?:\.enum|model:[A-Za-z_$][\w$]*)\(\["sonnet","opus","haiku","fable"(?:,"[^"]+"){0,50}\])(\)\.optional\(\)\.describe\()/gu;
      const aliasesStr = externalModels.map((m) => JSON.stringify(m.alias)).join(",");
      next = next.replace(zAnchor, (match, prefix, suffix) => {
          zodStash = match;
          return `${prefix},${aliasesStr}${suffix}`;
      });

      // The alias validator. This condition is DERIVED from externalModels; it used to
      // hardcode two aliases, so adding a row to the array silently produced a picker
      // entry the validator then rejected.
      const validatorCondition = externalModels
        .map((model) => `${JSON.stringify(model.alias)}`)
        .join(",");
      next = replaceUniqueAnchor(
        "alias-validator",
        next,
        /(\["sonnet","opus","haiku","fable"(?:,"[^"]+"){0,50}\],[A-Za-z_$][\w$]*=\["sonnet","opus","haiku","fable"(?:,"[^"]+"){0,50}\];var [A-Za-z_$][\w$]*="[^"]+";function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{)return ([A-Za-z_$][\w$]*)\.includes\(\2\)\}/u,
        (_match, head, argument, aliases) =>
          `${head}if([${validatorCondition}].indexOf(${argument})!==-1)return!0;return ${aliases}.includes(${argument})}`
      );

      // Anchor: the run of alias cases CLODEX's own PATCH 6 appends right after
      // `case"best":{...}`. Pinned to the SHAPE clodex emits, not to any alias inside it.
      //
      // MEASURED 2026-09-05 (independent audit, BULGU 3) and the reason this changed
      // again. The previous version freed the ORDER and the COUNT but still required
      // `case"sol":return "sol";` to be present: probe V5 configured CLODEX_HOME with
      // astra+terra and no sol, and all four resolver needles went to x0 -- i.e. the
      // Google and xAI lanes would have died because of which OpenAI models the operator
      // happens to have enabled. Two unrelated lanes must not share that fate.
      //
      // What stays pinned is clodex's own output: `case"best":{...}` is the seam clodex
      // itself anchors on (its PATCH 6 regex is /(case"best":\{[^{}]*\})/), and the run
      // that follows is what it appended. Requiring at least ONE appended case keeps the
      // negative arm honest: on a binary clodex never patched, nothing is injected.
      const resolverCases = externalModels
        .map((model) => `case${JSON.stringify(model.alias)}:return ${JSON.stringify(model.alias)};`)
        .join("");
      next = replaceUniqueAnchor(
        "alias-resolver",
        next,
        /(case"best":\{[^{}]*\}(?:case"[^"]+":return\s*"[^"]+";)+)/u,
        (existing) => `${existing}${resolverCases}`
      );

      const pickerEntries = externalModels
        .map((model) => `{value:${JSON.stringify(model.alias)},label:${JSON.stringify(model.label)},description:${JSON.stringify(model.description)}}`)
        .join(",");
      // Anchor: the picker array CLODEX's own PATCH 5 injected, identified by the
      // forEach shape it generates -- not by the text inside the first entry.
      //
      // MEASURED 2026-09-05, and the reason this changed. The old anchor spelled out
      // `description:"Custom model (clodex:openai:gpt-5.6-sol)"`, but clodex builds that
      // string as `clodex:${providerId}:${modelId}` from CLODEX_HOME/config.json. The
      // provider id there is "openai-oauth" today, so the anchor matched a shape the
      // patcher no longer emits: measured in the installed shadow binary,
      // "clodex:openai:gpt-5.6-sol" x1 (patched 2026-08-30, before the config change)
      // and "clodex:openai-oauth:..." x0. It also hardcoded Sol as the first row, which
      // a third alias (astra) or a reordered favorites file would break.
      //
      // Nothing here depends on which OpenAI models are configured; the shape does.
      next = replaceUniqueAnchor(
        "model-picker",
        next,
        /(\[\{value:"[^"]+",label:"[^"]+",description:"[^"]*"\}(?:,\{value:"[^"]+",label:"[^"]+",description:"[^"]*"\})*\])(\.forEach\(function\(_o\)\{if\(!([A-Za-z_$][\w$]*)\.some\(function\(_i\)\{return _i\.value===_o\.value\}\)\)\3\.push\(_o\)\}\);)/u,
        (_match, arr, loop, options) =>
          `${arr}${loop}[${pickerEntries}].forEach(function(_g){if(!${options}.some(function(_i){return _i.value===_g.value}))${options}.push(_g)});`
      );

      // Context windows are per-model now: the Google lane is 1M, the xAI lane is 500K.
      // A single shared constant would have advertised 1M for Grok and let Claude Code
      // build requests the xAI side would reject.
      const contextByIdentity = Object.create(null);
      for (const model of externalModels) {
        for (const identity of [model.alias, `${model.alias}[1m]`, model.fullId, `${model.fullId}[1m]`]) {
          contextByIdentity[identity] = model.contextWindow;
        }
      }

      const contextOverride =
        `var _hezarfenGoogleContext=Object.assign(Object.create(null),${JSON.stringify(contextByIdentity)})` +
        `[String(e||"").trim().toLowerCase()];if(_hezarfenGoogleContext!==void 0)return _hezarfenGoogleContext;`;

      next = replaceUniqueAnchor(
        "context-window-table",
        next,
        /\/\*ccpatch:ctx\*\//u,
        `${contextOverride}/*ccpatch:ctx*/`
      );

      let finalPatch = next;
      if (zodStash) {
         finalPatch += `\n/* clodex-proof-stash: ${zodStash} */\n`;
      }
      return finalPatch + `\n${marker}\n`;
    },
  },
];
