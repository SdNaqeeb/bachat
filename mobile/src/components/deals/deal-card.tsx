/**
 * One deal, and the evidence for it.
 *
 * The honesty rule (spec §7) is what shapes this card. A deal feed's whole
 * currency is the claim "this is a good price", and the only claim Bachat can
 * actually substantiate is "this is the lowest price *we have recorded*, over
 * the N days we have been recording". So the badge is `PeriodLowBadge`, which
 * takes the real `historyDays` and says "Lowest in 12 days" when that is the
 * truth; nothing in this file can produce the string "30-day low" on its own,
 * because the wording is derived from the data rather than written down here.
 *
 * Tapping expands the card in place rather than pushing a detail screen. The
 * question a deal card provokes is "is that actually cheap?", and the answer is
 * thirty days of history — which is a shape, not a page. Keeping it inline also
 * keeps the user's scroll position in a feed they are skimming.
 *
 * The image is small and to the left. Retailer photography is inconsistent, so
 * a large hero image would make the feed look broken on half its rows; the
 * price column is the constant, and it is what the eye tracks down.
 */

import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { Button } from '@/components/ui/button';
import { DiscountPill, PeriodLowBadge } from '@/components/ui/discount-pill';
import { PressableScale } from '@/components/ui/pressable-scale';
import { PriceText, StrikePrice } from '@/components/ui/price-text';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/components/ui/sparkline';
import { StalenessChip } from '@/components/ui/staleness-chip';
import { apiClient } from '@/lib/client';
import { messageForError } from '@/lib/api';
import { discountFraction, periodLowLabel, rupees } from '@/lib/format';
import type { Deal, PriceHistory, Retailer } from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

const THUMB = 60;
/** Sparkline drawing width. Measured on layout; this is the pre-measure guess. */
const CHART_FALLBACK_WIDTH = 280;

export type DealCardProps = {
  deal: Deal;
  retailer: Retailer;
  onBuy: () => void;
};

export function DealCard({ deal, retailer, onBuy }: DealCardProps) {
  const { offer } = deal;
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(CHART_FALLBACK_WIDTH);
  const reduceMotion = useReducedMotion();

  const toggle = useCallback(() => setOpen((previous) => !previous), []);

  // History is fetched only once the card is opened: a feed of forty deals must
  // not fire forty history requests to render.
  useEffect(() => {
    if (!open || history !== null) return;
    const controller = new AbortController();
    apiClient
      .history(offer.productId, controller.signal)
      .then(setHistory)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setHistoryError(messageForError(caught));
      });
    return () => controller.abort();
  }, [open, history, offer.productId]);

  const discount = deal.discountPct ?? discountFraction(offer.price, offer.mrp);
  // The claim, derived from the real N. Never a hardcoded window (spec §7).
  const lowClaim = offer.isPeriodLow ? periodLowLabel(offer.historyDays) : null;

  return (
    <View style={styles.card}>
      <PressableScale
        haptic="tap"
        activeScale={0.99}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${offer.name} at ${retailer.name}, ${rupees(offer.price)}${
          lowClaim ? `. ${lowClaim}` : ''
        }. Tap for its price history.`}
        style={styles.head}
      >
        {offer.imageUrl ? (
          <Image
            source={{ uri: offer.imageUrl }}
            style={styles.thumb}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Ionicons name="image-outline" size={20} color={palette.textMuted} />
          </View>
        )}

        <View style={styles.body}>
          <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={styles.name}>
            {offer.name}
          </Text>

          <View style={styles.retailerLine}>
            <RetailerBadge retailer={retailer} size={18} />
            <Text maxFontSizeMultiplier={1.2} style={styles.retailerName}>
              {retailer.name}
            </Text>
            {offer.pack ?? offer.size ? (
              <Text maxFontSizeMultiplier={1.2} style={styles.pack}>
                {offer.pack ?? offer.size}
              </Text>
            ) : null}
          </View>

          <View style={styles.badges}>
            {lowClaim ? <PeriodLowBadge historyDays={offer.historyDays} /> : null}
            <StalenessChip capturedAt={offer.capturedAt} mode={offer.mode} bare />
          </View>
        </View>

        <View style={styles.priceColumn}>
          <DiscountPill fraction={discount} variant="solid" />
          <PriceText amount={offer.price} />
          <StrikePrice mrp={offer.mrp} price={offer.price} />
        </View>
      </PressableScale>

      {open ? (
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(160)}
          exiting={reduceMotion ? undefined : FadeOut.duration(120)}
          style={styles.detail}
          onLayout={(event) =>
            setChartWidth(Math.max(80, event.nativeEvent.layout.width - spacing.lg * 2))
          }
        >
          {historyError !== null ? (
            <Text maxFontSizeMultiplier={1.3} style={styles.historyError}>
              {historyError}
            </Text>
          ) : history === null ? (
            <Skeleton width="100%" height={layout.sparklineHeight} />
          ) : (
            <>
              <Sparkline
                points={history.points}
                width={chartWidth}
                atLow={offer.isPeriodLow}
                showDayCount
              />
              <Text maxFontSizeMultiplier={1.3} style={styles.historyLine}>
                {/* The honest claim, spelled out with the real N (spec §7). */}
                {historyClaim(history, offer.price, offer.isPeriodLow)}
              </Text>
            </>
          )}

          {deal.savedAmount !== null && deal.savedAmount > 0 ? (
            <Text maxFontSizeMultiplier={1.3} style={styles.savedLine}>
              {rupees(deal.savedAmount)} off the printed price of {rupees(offer.mrp ?? 0)}.
            </Text>
          ) : null}

          <Button
            label={`Buy at ${retailer.name}`}
            icon="open-outline"
            size="sm"
            onPress={onBuy}
            style={styles.buy}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * The sentence under the sparkline. It states how much history exists before it
 * states anything about the price, so the user can judge the claim's weight —
 * "lowest in 12 days" is a much smaller thing than "lowest in 30 days" and the
 * interface must not let the two read the same.
 */
function historyClaim(history: PriceHistory, price: number, atLow: boolean): string {
  const days = history.days;
  if (days < 2) return 'Bachat has only just started tracking this price.';

  const window = days >= 30 ? 'the last 30 days' : `the ${days} days we have tracked it`;
  if (atLow) return `This is the lowest it has been in ${window}.`;
  return `Over ${window} it has ranged ${rupees(history.low)} to ${rupees(history.high)}${
    price > history.low ? `, and it has been ${rupees(price - history.low)} cheaper.` : '.'
  }`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.surface,
  },
  head: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: palette.surface,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.md,
    backgroundColor: palette.surfaceRaised,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: layout.hairline,
    borderColor: palette.line,
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  name: {
    ...type.rowTitle,
    color: palette.textPrimary,
  },
  retailerLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  retailerName: {
    ...type.caption,
    color: palette.textSecondary,
  },
  pack: {
    ...type.caption,
    color: palette.textMuted,
  },
  badges: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  priceColumn: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  detail: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
    backgroundColor: palette.surfaceRaised,
  },
  historyLine: {
    ...type.caption,
    color: palette.textSecondary,
  },
  historyError: {
    ...type.caption,
    color: palette.danger,
  },
  savedLine: {
    ...type.caption,
    color: palette.textMuted,
  },
  buy: {
    alignSelf: 'flex-start',
  },
});
