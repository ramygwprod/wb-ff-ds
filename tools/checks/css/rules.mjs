/**
 * Local CSS rules for the layout checks that @eslint/css doesn't provide.
 * Each one enforces exactly one layout rule; its messages start with that rule's ID.
 */
import { FLUID_UNIT, functionArguments, ruleMeta, walk } from './walk.mjs';

const isRootSelector = (selector) =>
  selector.children.length === 1 &&
  ((selector.children[0].type === 'TypeSelector' && selector.children[0].name === 'html') ||
    (selector.children[0].type === 'PseudoClassSelector' && selector.children[0].name === 'root'));

const isHundredPercent = (node) => node.type === 'Percentage' && Number(node.value) === 100;

/** L-T7: the root font size is never px; if html (or :root) sets one, it is 100%. */
const rootFontSize = {
  meta: ruleMeta('L-T7: the root font size is 100% or unset.', {
    notHundred:
      "L-T7: the root font size must be 100% (or unset), so the user's browser text size still scales everything.",
  }),
  create(context) {
    return {
      Rule(node) {
        const selectors = node.prelude?.children ?? [];
        if (!selectors.some((s) => s.type === 'Selector' && isRootSelector(s))) return;
        for (const declaration of node.block.children) {
          if (declaration.type !== 'Declaration') continue;
          const property = declaration.property.toLowerCase();
          const values = declaration.value.children ?? [];
          if (property === 'font-size' && !(values.length === 1 && isHundredPercent(values[0]))) {
            context.report({ node: declaration, messageId: 'notHundred' });
          }
          if (property === 'font' && !values.some(isHundredPercent)) {
            context.report({ node: declaration, messageId: 'notHundred' });
          }
        }
      },
    };
  },
};

/** L-F1: a fluid clamp() middle term mixes rem with a viewport or container unit. */
const fluidClampMix = {
  meta: ruleMeta('L-F1: fluid clamp() middle terms mix rem with a viewport or container unit.', {
    noRem:
      'L-F1: this clamp() middle term uses only {{units}}; add a rem term so it still responds to zoom.',
  }),
  create(context) {
    return {
      Function(node) {
        if (node.name.toLowerCase() !== 'clamp') return;
        const middle = functionArguments(node)[1];
        if (!middle) return;
        const units = new Set();
        walk(middle, (child) => {
          if (child.type === 'Dimension') units.add(child.unit.toLowerCase());
        });
        const fluid = [...units].filter((u) => FLUID_UNIT.test(u));
        if (fluid.length > 0 && !units.has('rem')) {
          context.report({ node, messageId: 'noRem', data: { units: fluid.join(', ') } });
        }
      },
    };
  },
};

const VIEWPORT_SIZE_FEATURES = new Set(
  ['width', 'height', 'device-width', 'device-height'].flatMap((f) => [f, `min-${f}`, `max-${f}`]),
);
const isSizeName = (node) =>
  node?.type === 'Identifier' && VIEWPORT_SIZE_FEATURES.has(node.name.toLowerCase());

/** L-L1: component styles contain no viewport @media width or height queries. */
const noViewportMedia = {
  meta: ruleMeta('L-L1: no viewport @media width or height queries in component styles.', {
    viewportQuery:
      'L-L1: components respond to their container; use @container instead of a viewport "{{feature}}" query.',
  }),
  create(context) {
    return {
      Atrule(node) {
        if (node.name.toLowerCase() !== 'media' || !node.prelude) return;
        walk(node.prelude, (child) => {
          if (child.type === 'Feature' && VIEWPORT_SIZE_FEATURES.has(child.name.toLowerCase())) {
            context.report({
              node: child,
              messageId: 'viewportQuery',
              data: { feature: child.name },
            });
          }
          if (child.type === 'FeatureRange') {
            const named = [child.left, child.middle, child.right].find(isSizeName);
            if (named) {
              context.report({
                node: child,
                messageId: 'viewportQuery',
                data: { feature: named.name },
              });
            }
          }
        });
      },
    };
  },
};

const GRID_TRACK_PROPERTIES = new Set([
  'grid-template-columns',
  'grid-template-rows',
  'grid-template',
  'grid',
  'grid-auto-columns',
  'grid-auto-rows',
]);
const INTRINSIC_MINIMUMS = new Set(['auto', 'min-content', 'max-content']);

/**
 * L-L3: a flexible (fr) track sits in minmax() with an explicit minimum, minmax(0, 1fr) by
 * default. An explicit minimum track size is also accepted, because L-L2's calculated
 * thresholds are built from minimum track sizes.
 */
const flexibleTracks = {
  meta: ruleMeta('L-L3: flexible grid tracks use minmax() with an explicit minimum.', {
    bareFr:
      "L-L3: write minmax(0, {{track}}) instead of a bare {{track}}, so long content can't widen the track.",
    intrinsicMin:
      'L-L3: minmax({{min}}, …) lets content widen the track; use 0 or a minimum track size.',
  }),
  create(context) {
    return {
      Declaration(node) {
        if (!GRID_TRACK_PROPERTIES.has(node.property.toLowerCase())) return;
        walk(node.value, (child, parent) => {
          if (child.type !== 'Dimension' || child.unit.toLowerCase() !== 'fr') return;
          const track = `${child.value}fr`;
          if (parent?.type !== 'Function' || parent.name.toLowerCase() !== 'minmax') {
            context.report({ node: child, messageId: 'bareFr', data: { track } });
            return;
          }
          const [min, max] = functionArguments(parent);
          if (!max?.includes(child)) {
            context.report({ node: child, messageId: 'bareFr', data: { track } });
            return;
          }
          const first = min?.[0];
          if (first?.type === 'Identifier' && INTRINSIC_MINIMUMS.has(first.name.toLowerCase())) {
            context.report({ node: first, messageId: 'intrinsicMin', data: { min: first.name } });
          }
        });
      },
    };
  },
};

/** L-L8: full-height surfaces use dvh, svh or lvh, never 100vh. */
const no100vh = {
  meta: ruleMeta('L-L8: no 100vh.', {
    hundredVh: 'L-L8: 100vh can be cut off by mobile browser bars; use 100dvh, 100svh or 100lvh.',
  }),
  create(context) {
    return {
      Dimension(node) {
        if (node.unit.toLowerCase() === 'vh' && Number(node.value) === 100) {
          context.report({ node, messageId: 'hundredVh' });
        }
      },
    };
  },
};

const REVERSED = new Set(['row-reverse', 'column-reverse']);

/** L-O1: no order property and no row-reverse or column-reverse. */
const noVisualReorder = {
  meta: ruleMeta('L-O1: visual order follows source order.', {
    order: 'L-O1: "order" makes the visual order differ from the reading and focus order.',
    reversed: 'L-O1: "{{value}}" makes the visual order differ from the reading and focus order.',
  }),
  create(context) {
    return {
      Declaration(node) {
        const property = node.property.toLowerCase();
        if (property === 'order') {
          context.report({ node, messageId: 'order' });
          return;
        }
        if (property !== 'flex-direction' && property !== 'flex-flow') return;
        for (const child of node.value.children ?? []) {
          if (child.type === 'Identifier' && REVERSED.has(child.name.toLowerCase())) {
            context.report({ node: child, messageId: 'reversed', data: { value: child.name } });
          }
        }
      },
    };
  },
};

/** L-R4: direction-specific styling uses :dir(), not [dir] attribute selectors. */
const noDirAttribute = {
  meta: ruleMeta('L-R4: :dir() instead of [dir] selectors.', {
    dirAttribute:
      'L-R4: use :dir(rtl) or :dir(ltr) instead of a [dir] attribute selector; it follows inherited direction.',
  }),
  create(context) {
    return {
      AttributeSelector(node) {
        if (node.name?.name?.toLowerCase() === 'dir') {
          context.report({ node, messageId: 'dirAttribute' });
        }
      },
    };
  },
};

/** The local plugin, registered as "wbff" in the ESLint config. */
export default {
  meta: { name: 'wbff-css-checks' },
  rules: {
    'root-font-size': rootFontSize,
    'fluid-clamp-mix': fluidClampMix,
    'no-viewport-media': noViewportMedia,
    'flexible-tracks': flexibleTracks,
    'no-100vh': no100vh,
    'no-visual-reorder': noVisualReorder,
    'no-dir-attribute': noDirAttribute,
  },
};
