/**
 * How old this price is, in a chip.
 *
 * Spec §9 makes this non-optional: "every price shown carries its `captured_at`
 * age", because the app is useless if it cannot say "prices are 4 hours old"
 * when a sweep has failed. That is why this is a real, reusable component with
 * its own clock rather than a string formatted inline in each screen.
 *
 * The chip re-renders itself on a one-minute tick, so a screen left open does
 * not quietly keep claiming "just now" an hour later. The tick is skipped once
 * the price is over a day old, where a minute no longer changes the wording.
 *
 * Colour is the signal: neutral while fresh, marigold once a sweep has been
 * missed, marigold-on-wash once two have. Freshness thresholds differ by mode —
 * quick-commerce prices go off in hours, fashion prices in days.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ageLabel, freshnessOf, type Freshness } from '@/lib/format';
import type { Mode } from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

/** How often the label refreshes while it is still minute-precise. */
const TICK_MS = 60_000;
const DAY_MS = 86_400_000;
/** Dot diameter. Derived locally — smaller than any spacing token. */
const DOT = 5;

export type StalenessChipProps = {
  /** Epoch ms, straight off `Offer.capturedAt` or `BasketQuote.capturedAt`. */
  capturedAt: number;
  /** Decides the freshness thresholds. Pass `useMode().mode`. */
  mode: Mode;
  /**
   * Prefix for the label, e.g. "Swept". Default is bare: "4 hours ago".
   * Keep it short — this chip sits at the end of a dense row.
   */
  prefix?: string;
  /** Drops the chip's border and background, for use inside a coloured card. */
  bare?: boolean;
  style?: StyleProp<ViewStyle>;
};

const TONE: Record<Freshness, { fg: string; bg: string; border: string }> = {
  fresh: { fg: palette.textMuted, bg: palette.surface, border: palette.line },
  ageing: { fg: palette.stale, bg: palette.surface, border: palette.line },
  stale: { fg: palette.stale, bg: palette.staleWash, border: 'transparent' },
};

export function StalenessChip({
  capturedAt,
  mode,
  prefix,
  bare = false,
  style,
}: StalenessChipProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Past a day the wording only changes daily, so stop waking the JS thread.
    if (Date.now() - capturedAt > DAY_MS) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [capturedAt]);

  const freshness = freshnessOf(capturedAt, mode, now);
  const tone = TONE[freshness];
  const label = ageLabel(capturedAt, now);
  const text = prefix ? `${prefix} ${label}` : label;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Price captured ${label}`}
      style={[
        styles.chip,
        bare
          ? styles.bare
          : { backgroundColor: tone.bg, borderColor: tone.border, borderWidth: layout.hairline },
        style,
      ]}
    >
      {freshness === 'fresh' ? null : (
        <View style={[styles.dot, { backgroundColor: tone.fg }]} />
      )}
      <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={[styles.label, { color: tone.fg }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  bare: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
  label: {
    ...type.tag,
  },
});
