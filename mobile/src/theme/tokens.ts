/**
 * Bachat design tokens — the single source of visual truth.
 *
 * Direction. Bachat is a decision utility, not a shopping feed: the user opens
 * it at the kitchen counter, in daylight, and wants one answer in two seconds.
 * That brief drives every choice here.
 *
 * - **Sage paper, not white and not cream.** `void` is a faint green-grey so a
 *   pure-white price card lifts off it without a shadow. It is also darker than
 *   a bright white page, which is what stops the screen glaring outdoors.
 * - **Chrome is quiet, signals are loud.** Navigation, headers and body type
 *   are near-black `ink`. Colour is reserved for three functional signals and
 *   nothing else: `save` (green — a saving, a win, a discount), `stale`
 *   (marigold — this price is older than you think) and `danger` (chilli — out
 *   of stock, or the sweep failed). Because no chrome is green, a green number
 *   always means money.
 * - **Mode is a hue, not a label.** Quick Commerce and Fashion each own an
 *   accent (`mode.quick` / `mode.fashion`). The switch, the active tab and the
 *   focused filter take their colour from the current mode, so the app looks
 *   subtly different in each without a banner announcing it. Read these through
 *   `useMode().accent`, never by hardcoding a branch.
 * - **Flat by default.** A list of twelve price rows with twelve shadows reads
 *   as noise. Separation is hairlines; `elevation` is spent on exactly three
 *   things — the header, the mode-switch thumb and the winner card.
 *
 * Deliberately absent: an all-caps tracked-out label style. Uppercase micro
 * labels are slower to read at a glance and Bachat is nothing but glances, so
 * `type.tag` stays sentence case.
 */

export const palette = {
  /** Page ground. Faint sage so white cards separate without a border. */
  void: '#ECEFE9',
  /** Cards, rows, sheets — the paper prices sit on. */
  surface: '#FFFFFF',
  /** Recessed fills: search fields, segmented tracks, table headers. */
  surfaceRaised: '#F3F6F0',
  surfacePressed: '#E3E8DE',
  /** Hairlines. `line` divides rows; `lineStrong` divides sections. */
  line: '#DFE4DA',
  lineStrong: '#C2CBBA',

  /** Near-black with a green soul. Chrome, headers, tab bar, primary type. */
  ink: '#111C18',
  textPrimary: '#111C18',
  textSecondary: '#4E5C56',
  textMuted: '#85918B',
  /** Type sitting on `ink`, `save`, or a mode accent. */
  textInverse: '#FFFFFF',

  /** Signal: money saved. Discount pills, winner cards, "cheapest" marks. */
  save: '#0B7A4B',
  saveWash: 'rgba(11, 122, 75, 0.10)',
  saveHairline: 'rgba(11, 122, 75, 0.28)',

  /** Signal: this price is ageing. Staleness chips, failed-sweep banners. */
  stale: '#B4690E',
  staleWash: 'rgba(180, 105, 14, 0.10)',

  /** Signal: out of stock, unreachable server, destructive action. */
  danger: '#C0341D',
  dangerWash: 'rgba(192, 52, 29, 0.09)',

  /**
   * Mode identity. Every mode-aware surface reads these through `useMode()`.
   * Both are dark enough to carry white type at 4.5:1.
   */
  mode: {
    /** Quick Commerce — deep teal, the colour of a cold-chain shelf. */
    quick: {
      accent: '#12594F',
      wash: 'rgba(18, 89, 79, 0.10)',
      hairline: 'rgba(18, 89, 79, 0.30)',
    },
    /** Fashion — deep plum, warmer and softer without being decorative. */
    fashion: {
      accent: '#7A2A55',
      wash: 'rgba(122, 42, 85, 0.10)',
      hairline: 'rgba(122, 42, 85, 0.30)',
    },
  },

  /**
   * Mode-agnostic accent for chrome that renders before the mode is known
   * (splash, focus rings, the loading skeleton). Matches Quick Commerce
   * because that is the default mode.
   */
  accent: '#12594F',
  accentWash: 'rgba(18, 89, 79, 0.10)',
} as const;

/** 4px base. `md` (12) is the row rhythm; `lg` (16) is the screen gutter. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 44,
} as const;

export const radius = {
  /** Chips, pills and small badges. */
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/** Font families registered by `useAppFonts` in src/theme/fonts.ts. */
export const fonts = {
  /**
   * Archivo — a sturdy grotesque with wide apertures and even colour at small
   * sizes. Carries every number and heading; it is the one family that has to
   * survive a squint in sunlight.
   */
  display: 'Archivo_700Bold',
  displayHeavy: 'Archivo_800ExtraBold',
  displayMedium: 'Archivo_600SemiBold',
  /** Manrope — rounder and quieter. Body copy, labels, captions. */
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemi: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
} as const;

/**
 * Numerals are set with `tabular-nums` rather than in a monospace family.
 * Column alignment down a list of prices is the only thing a mono face would
 * have bought us, and this buys it without a third font in the APK.
 */
// Not `as const`: React Native types `fontVariant` as a mutable array, so a
// readonly tuple here would make every price style unassignable to TextStyle.
const TABULAR: 'tabular-nums'[] = ['tabular-nums'];

export const type = {
  /** The one number that answers the question: a basket total, a winner price. */
  priceHero: {
    fontFamily: fonts.displayHeavy,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -1,
    fontVariant: TABULAR,
  },
  /** The price on a comparison row. */
  price: {
    fontFamily: fonts.displayHeavy,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.6,
    fontVariant: TABULAR,
  },
  /** Secondary numbers: struck-through MRP, per-unit price, fees. */
  priceSmall: {
    fontFamily: fonts.displayMedium,
    fontSize: 14,
    lineHeight: 19,
    letterSpacing: -0.1,
    fontVariant: TABULAR,
  },

  title: { fontFamily: fonts.display, fontSize: 21, lineHeight: 27, letterSpacing: -0.5 },
  subtitle: { fontFamily: fonts.displayMedium, fontSize: 16, lineHeight: 22, letterSpacing: -0.2 },
  /** Product name on a dense row — Archivo so it holds its shape when clipped. */
  rowTitle: { fontFamily: fonts.displayMedium, fontSize: 14.5, lineHeight: 19, letterSpacing: -0.1 },

  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: fonts.bodySemi, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: fonts.bodySemi, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  /** Chip and badge text: staleness, stock counts, retailer names. */
  tag: { fontFamily: fonts.bodySemi, fontSize: 11.5, lineHeight: 15, letterSpacing: 0.1 },
} as const;

/**
 * Android elevation + matching shadow.
 *
 * Three entries, on purpose. Lists get hairlines; only surfaces that genuinely
 * float above the page get a shadow, and it is tinted with `ink` because pure
 * black over sage reads as dirt.
 */
export const elevation = {
  /** The sticky header and the tab bar, once the list scrolls under them. */
  chrome: {
    shadowColor: '#111C18',
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  /** The winner card — the single most important object on the Basket screen. */
  raised: {
    shadowColor: '#111C18',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  /** The mode-switch thumb, so it reads as a physical object on its track. */
  thumb: {
    shadowColor: '#111C18',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
} as const;

/** Shared motion vocabulary. Every animation in the app pulls from here. */
export const motion = {
  /** Anything the user directly caused: a press, a tab change. */
  snappy: { damping: 18, stiffness: 240, mass: 0.9 },
  /** Entrances and layout shifts. */
  gentle: { damping: 22, stiffness: 150, mass: 1 },
  /**
   * The mode switch. Lower damping than `snappy` so the thumb overshoots a
   * touch and settles — this is the app's signature interaction and it should
   * feel like flicking a physical toggle, not fading a colour.
   */
  toggle: { damping: 15, stiffness: 210, mass: 0.8 },
  duration: { fast: 130, base: 220, slow: 380, pulse: 1100 },
  /** Stagger between sibling entrance animations, in ms. */
  stagger: 45,
} as const;

export const layout = {
  /** Tighter than a reading app: this is a dense table, not prose. */
  screenPadding: spacing.lg,
  hairline: 1,
  /** Minimum height of a comparison row — one thumb, comfortably. */
  rowHeight: 64,
  /** Retailer logo square inside a price row. */
  retailerMark: 34,
  headerHeight: 56,
  tabBarHeight: 58,
  /** Inline price-history sparkline. */
  sparklineHeight: 34,
  /** Body copy never runs wider than this, even on a tablet. */
  proseMaxWidth: 460,
} as const;
