/**
 * Shared helpers for the local CSS rules. The syntax tree comes from @eslint/css (CSSTree);
 * its children are plain arrays.
 */

/** Visits every node under `node`, depth first, with its parent and its index in the parent. */
export function walk(node, visit, parent = null, index = -1) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, visit, parent, i));
    return;
  }
  if (typeof node.type === 'string') visit(node, parent, index);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (value && typeof value === 'object') walk(value, visit, node, -1);
  }
}

/** Splits a function's children into its comma-separated arguments. */
export function functionArguments(fn) {
  const args = [[]];
  for (const child of fn.children ?? []) {
    if (child.type === 'Operator' && child.value.trim() === ',') args.push([]);
    else args.at(-1).push(child);
  }
  return args;
}

/** Viewport units (vw, vi, svh, dvb, vmin, …) and container units (cqi, cqw, …). */
export const FLUID_UNIT = /^(?:[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/i;

/** A rule's messages start with the layout rule ID it enforces, so a failure names its rule. */
export function ruleMeta(description, messages) {
  return {
    type: 'problem',
    languages: ['css/css'],
    docs: { description },
    schema: [],
    messages,
  };
}
