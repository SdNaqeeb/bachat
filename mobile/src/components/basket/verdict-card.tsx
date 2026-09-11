/**
 * The answer. This card is the whole product (spec §8).
 *
 * The user is standing at a kitchen counter holding a phone at arm's length.
 * They have one question — which app do I order from — and this card has about
 * one second to answer it. So the retailer's name and the basket total are the
 * only things set large, and the total is the one `type.priceHero` in the
 * entire app; nothing else is allowed to compete at that size.
 *
 * Three deliberate refusals:
 *
 * - **The saving is against the runner-up, never the worst option.** Beating
 *   the most expensive app by ₹210 is a number that flatters the app and
 *   misleads the user. The honest comparison is the next-best real choice, so
 *   that is the only one shown.
 * - **Fees are on the card, not behind a tap.** A total that excludes delivery
 *   is the exact mistake this app exists to stop the user making by hand, so
 *   the ledger line under the button states items, delivery and handling.
 * - **The age is on the card too.** A confident total over a silently failed
 *   sweep is the worst outcome Bachat can produce (spec §9), so the staleness
 *   chip sits in the same row as the stock count, not hidden in a detail view.
 *
 * The single orchestrated animation in the app lives here: the card rises once
 * when a comparison lands, which is the moment the answer changed.
 */

import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { PriceText } from '@/components/ui/price-text';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { StalenessChip } from '@/components/ui/staleness-chip';
import { etaLabel, rupees } from '@/lib/format';
import type { BasketQuote, Mode, Retailer } from '@/lib/types';
import { elevation, layout, motion, palette, radius, spacing, type } from '@/theme';

/** Entrance travel of the card, in px. Derived locally. */
const RISE = 16;

export type VerdictCardProps = {
  quote: BasketQuote;
  retailer: Retailer;
  mode: Mode;
  /** Rupees saved against the runner-up. Null when there is no second option. */
  saving: number | null;
  /** Name of the retailer that saving is measured against. */
  runnerUpName: string | null;
  /** Deep-links into the retailer's own app (spec §9). */
  onBuy: () => void;
};

export function VerdictCard({
  quote,
  retailer,
  mode,
  saving,
  runnerUpName,
  onBuy,
}: VerdictCardProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  // Keyed on the retailer, so the card re-plays only when the verdict actually
  // changes — not on every refresh that confirms the same answer.
  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withSpring(1, motion.gentle);
  }, [progress, reduceMotion, quote.retailerId]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: interpolate(progress.value, [0, 1], [RISE, 0]) }],
  }));

  const eta = etaLabel(quote.etaMinutes);
  const fees = quote.deliveryFee + quote.handlingFee;

  return (
    <Animated.View style={[styles.card, elevation.raised, animatedStyle]}>
      <View style={styles.top}>
        <RetailerBadge retailer={retailer} variant="full" size={40} />
        <View style={styles.cheapest}>
          <Text maxFontSizeMultiplier={1.2} style={styles.cheapestLabel}>
            Cheapest total
          </Text>
        </View>
      </View>

      <View style={styles.totalBlock}>
        <PriceText amount={quote.total} size="hero" />
        {saving !== null && saving > 0 && runnerUpName ? (
          <Text maxFontSizeMultiplier={1.3} style={styles.saving}>
            {rupees(saving)} less than {runnerUpName}
          </Text>
        ) : (
          <Text maxFontSizeMultiplier={1.3} style={styles.savingFlat}>
            {runnerUpName
              ? `Level with ${runnerUpName} — order from whichever you prefer`
              : 'The only app with your whole basket in stock'}
          </Text>
        )}
      </View>

      <View style={styles.meta}>
        <Text maxFontSizeMultiplier={1.2} style={styles.metaText}>
          All {quote.itemCount} items in stock
        </Text>
        {eta ? (
          <>
            <View style={styles.metaDot} />
            <Text maxFontSizeMultiplier={1.2} style={styles.metaText}>
              {eta}
            </Text>
          </>
        ) : null}
        <View style={styles.metaDot} />
        <StalenessChip capturedAt={quote.capturedAt} mode={mode} prefix="priced" bare />
      </View>

      <Button label={`Open ${retailer.name}`} icon="bag-handle-outline" block onPress={onBuy} />

      <Text maxFontSizeMultiplier={1.2} style={styles.ledger}>
        {rupees(quote.itemsTotal)} of groceries
        {fees > 0
          ? `, plus ${rupees(quote.deliveryFee)} delivery${
              quote.handlingFee > 0 ? ` and ${rupees(quote.handlingFee)} handling` : ''
            }`
          : ', no delivery or handling fee'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: layout.screenPadding,
    padding: spacing.xl,
    borderRadius: radius.xl,
    backgroundColor: palette.surface,
    borderWidth: layout.hairline,
    borderColor: palette.saveHairline,
    gap: spacing.lg,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  cheapest: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: palette.saveWash,
  },
  cheapestLabel: {
    ...type.tag,
    color: palette.save,
  },
  totalBlock: {
    gap: spacing.xs,
  },
  saving: {
    ...type.bodyStrong,
    color: palette.save,
  },
  savingFlat: {
    ...type.body,
    color: palette.textSecondary,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  metaText: {
    ...type.caption,
    color: palette.textSecondary,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: palette.lineStrong,
  },
  ledger: {
    ...type.caption,
    color: palette.textMuted,
  },
});
