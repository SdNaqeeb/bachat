/**
 * Every retailer that is not the winner, and the reason it is not.
 *
 * The hard rule of spec §8 is that a retailer missing items can never win
 * outright, and the hard rule of a trustworthy interface is that the user must
 * be able to see *why* a lower number is not on top. So a partial quote states
 * its gap by name — "6 of 7 — no Amul Taaza 500 ml" — and, when its total is
 * genuinely lower than the winner's, says the quiet part out loud: you would
 * pay less and still have to make a second order somewhere else.
 *
 * That is also why a partial total is set in `textSecondary` rather than ink.
 * It is a real number, so it is shown; it is not a usable answer, so it does
 * not get the weight of one.
 *
 * Expanding shows the per-item ledger, each price carrying its own staleness
 * chip (spec §9) because one retailer's rows can be four hours older than
 * another's inside the same comparison.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { Button } from '@/components/ui/button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { PriceText } from '@/components/ui/price-text';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { StalenessChip } from '@/components/ui/staleness-chip';
import { etaLabel, rupees } from '@/lib/format';
import type { BasketLine, BasketQuote, Mode, Retailer } from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

export type ContenderRowProps = {
  quote: BasketQuote;
  retailer: Retailer;
  lines: BasketLine[];
  mode: Mode;
  /** The winning total, so this row can state its own difference against it. */
  winnerTotal: number | null;
  onBuy: () => void;
};

/** "no Amul Taaza 500 ml" / "no Amul Taaza 500 ml and 2 more". */
function gapLabel(missing: string[]): string {
  const [first, ...rest] = missing;
  if (!first) return '';
  if (rest.length === 0) return `no ${first}`;
  return `no ${first} and ${rest.length} more`;
}

export function ContenderRow({
  quote,
  retailer,
  lines,
  mode,
  winnerTotal,
  onBuy,
}: ContenderRowProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const toggle = useCallback(() => setOpen((previous) => !previous), []);

  const partial = !quote.fullyStocked;
  const difference = winnerTotal === null ? null : quote.total - winnerTotal;
  const eta = etaLabel(quote.etaMinutes);

  return (
    <View style={styles.root}>
      <PressableScale
        haptic="tap"
        activeScale={0.99}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${retailer.name}, ${rupees(quote.total)} total${
          partial ? `, ${quote.inStockCount} of ${quote.itemCount} in stock` : ''
        }. Tap for the item by item breakdown.`}
        style={styles.head}
      >
        <RetailerBadge retailer={retailer} muted={partial} />

        <View style={styles.headBody}>
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.name}>
            {retailer.name}
          </Text>

          {partial ? (
            <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={styles.gap}>
              {quote.inStockCount} of {quote.itemCount} — {gapLabel(quote.missing)}
            </Text>
          ) : (
            <View style={styles.subMeta}>
              <Text maxFontSizeMultiplier={1.2} style={styles.sub}>
                All {quote.itemCount} in stock
              </Text>
              {eta ? (
                <Text maxFontSizeMultiplier={1.2} style={styles.sub}>
                  {eta}
                </Text>
              ) : null}
            </View>
          )}

          <StalenessChip capturedAt={quote.capturedAt} mode={mode} prefix="priced" bare />
        </View>

        <View style={styles.priceColumn}>
          <PriceText
            amount={quote.total}
            color={partial ? palette.textSecondary : palette.textPrimary}
          />
          {difference !== null && difference !== 0 ? (
            <Text maxFontSizeMultiplier={1.2} style={styles.difference}>
              {difference > 0 ? `${rupees(difference)} more` : `${rupees(-difference)} less`}
            </Text>
          ) : null}
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={palette.textMuted}
          />
        </View>
      </PressableScale>

      {/* The sentence that makes a cheaper-but-partial quote honest. */}
      {partial && difference !== null && difference < 0 ? (
        <View style={styles.caveat}>
          <Ionicons name="information-circle-outline" size={15} color={palette.stale} />
          <Text maxFontSizeMultiplier={1.3} style={styles.caveatText}>
            {rupees(-difference)} cheaper on what it has, but you would order the rest
            somewhere else — and pay a second delivery.
          </Text>
        </View>
      ) : null}

      {open ? (
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(160)}
          exiting={reduceMotion ? undefined : FadeOut.duration(120)}
          style={styles.detail}
        >
          {lines.map((line) => {
            const offer = line.offers.find(
              (candidate) => candidate.retailerId === retailer.id
            );
            const available = offer !== undefined && offer.inStock;

            return (
              <View key={line.item.id} style={styles.detailRow}>
                <View style={styles.detailBody}>
                  <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.detailName}>
                    {line.item.label}
                    {line.item.qty > 1 ? ` × ${line.item.qty}` : ''}
                  </Text>
                  {offer ? (
                    <StalenessChip capturedAt={offer.capturedAt} mode={mode} bare />
                  ) : null}
                </View>

                {available ? (
                  <PriceText amount={offer.price * line.item.qty} size="small" />
                ) : (
                  <Text maxFontSizeMultiplier={1.2} style={styles.unavailable}>
                    {offer ? 'Out of stock' : 'Not stocked'}
                  </Text>
                )}
              </View>
            );
          })}

          <View style={styles.feeBlock}>
            <FeeLine label="Items" amount={quote.itemsTotal} />
            <FeeLine label="Delivery" amount={quote.deliveryFee} />
            <FeeLine label="Handling" amount={quote.handlingFee} />
            <View style={styles.feeTotal}>
              <Text maxFontSizeMultiplier={1.3} style={styles.feeTotalLabel}>
                Basket total
              </Text>
              <PriceText amount={quote.total} size="small" />
            </View>
          </View>

          <Button
            label={`Open ${retailer.name}`}
            tone="quiet"
            size="sm"
            icon="open-outline"
            onPress={onBuy}
            style={styles.detailAction}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function FeeLine({ label, amount }: { label: string; amount: number }) {
  return (
    <View style={styles.feeLine}>
      <Text maxFontSizeMultiplier={1.3} style={styles.feeLabel}>
        {label}
      </Text>
      <Text maxFontSizeMultiplier={1.2} style={styles.feeValue}>
        {amount > 0 ? rupees(amount) : 'Free'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: palette.surface,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: layout.rowHeight,
    backgroundColor: palette.surface,
  },
  headBody: {
    flex: 1,
    gap: spacing.xxs,
  },
  name: {
    ...type.subtitle,
    color: palette.textPrimary,
  },
  subMeta: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  sub: {
    ...type.caption,
    color: palette.textSecondary,
  },
  gap: {
    ...type.caption,
    color: palette.stale,
  },
  priceColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxs,
  },
  difference: {
    ...type.tag,
    color: palette.textMuted,
  },
  caveat: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: palette.staleWash,
  },
  caveatText: {
    flex: 1,
    ...type.caption,
    color: palette.textSecondary,
  },
  detail: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    backgroundColor: palette.surfaceRaised,
    paddingTop: spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  detailBody: {
    flex: 1,
    gap: spacing.xxs,
  },
  detailName: {
    ...type.rowTitle,
    color: palette.textPrimary,
  },
  unavailable: {
    ...type.tag,
    color: palette.danger,
  },
  feeBlock: {
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: layout.hairline,
    borderTopColor: palette.line,
    gap: spacing.xs,
  },
  feeLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  feeLabel: {
    ...type.caption,
    color: palette.textSecondary,
  },
  feeValue: {
    ...type.priceSmall,
    color: palette.textSecondary,
  },
  feeTotal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  feeTotalLabel: {
    ...type.label,
    color: palette.textPrimary,
  },
  detailAction: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
  },
});
