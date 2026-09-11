/**
 * One retailer's offer for one product — the atom the whole app is made of.
 *
 * Reading order is the decision order: who is selling it, what it is, what it
 * costs, and how old that price is. The price sits hard right in a fixed-width
 * column with tabular figures, so a stack of these scans as a table even though
 * each row is an independent pressable.
 *
 * Emphasis is spent once. `win` turns the price green and adds a hairline
 * "Cheapest" rail on the leading edge; nothing else in the row competes.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { DiscountPill, OutOfStockPill, PeriodLowBadge } from '@/components/ui/discount-pill';
import { PressableScale } from '@/components/ui/pressable-scale';
import { PriceText, StrikePrice } from '@/components/ui/price-text';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { StalenessChip } from '@/components/ui/staleness-chip';
import { discountFraction } from '@/lib/format';
import type { Offer, Retailer } from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

/** Width of the "Cheapest" rail on the leading edge. Derived locally. */
const WIN_RAIL = 3;

export type PriceRowProps = {
  offer: Offer;
  /** Looked up by the caller from facets — the row does not fetch. */
  retailer: Retailer;
  /** Marks this as the cheapest in-stock offer in its group. */
  win?: boolean;
  /**
   * Secondary line under the product name. Defaults to brand + pack/size.
   * Pass a string to override, e.g. a per-unit price.
   */
  subtitle?: string;
  /** Show the product name. Off in a per-product comparison, where it repeats. */
  showName?: boolean;
  /** Deep-links into the retailer's app to buy (spec §9). */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function PriceRow({
  offer,
  retailer,
  win = false,
  subtitle,
  showName = true,
  onPress,
  style,
}: PriceRowProps) {
  const discount = discountFraction(offer.price, offer.mrp);
  const secondary =
    subtitle ??
    [offer.brand, offer.pack ?? offer.size].filter(Boolean).join(' · ');

  return (
    <PressableScale
      onPress={onPress}
      disabled={onPress === undefined}
      accessibilityRole={onPress ? 'button' : 'summary'}
      accessibilityLabel={`${retailer.name}, ${offer.name}`}
      activeScale={0.99}
      style={[styles.row, win && styles.rowWin, !offer.inStock && styles.rowOut, style]}
    >
      {win ? <View style={styles.rail} /> : null}

      <RetailerBadge retailer={retailer} muted={!offer.inStock} />

      <View style={styles.body}>
        {showName ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.name}>
            {offer.name}
          </Text>
        ) : (
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.name}>
            {retailer.name}
          </Text>
        )}
        {secondary.length > 0 ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.secondary}>
            {secondary}
          </Text>
        ) : null}

        <View style={styles.badges}>
          {offer.inStock ? null : <OutOfStockPill />}
          {offer.inStock && offer.isPeriodLow ? (
            <PeriodLowBadge historyDays={offer.historyDays} />
          ) : null}
          <StalenessChip capturedAt={offer.capturedAt} mode={offer.mode} bare />
        </View>
      </View>

      <View style={styles.priceColumn}>
        <PriceText amount={offer.price} win={win && offer.inStock} />
        <View style={styles.mrpRow}>
          <StrikePrice mrp={offer.mrp} price={offer.price} />
          <DiscountPill fraction={discount} />
        </View>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.rowHeight,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: palette.surface,
  },
  rowWin: {
    backgroundColor: palette.saveWash,
  },
  rowOut: {
    backgroundColor: palette.surfaceRaised,
  },
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: WIN_RAIL,
    borderTopRightRadius: radius.xs,
    borderBottomRightRadius: radius.xs,
    backgroundColor: palette.save,
  },
  body: {
    flex: 1,
    gap: spacing.xxs,
  },
  name: {
    ...type.rowTitle,
    color: palette.textPrimary,
  },
  secondary: {
    ...type.caption,
    color: palette.textSecondary,
  },
  badges: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xxs,
  },
  priceColumn: {
    alignItems: 'flex-end',
    gap: spacing.xxs,
  },
  mrpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});

export type RowDividerProps = { style?: StyleProp<ViewStyle> };

/** The hairline between rows. Separation is a line here, never a shadow. */
export function RowDivider({ style }: RowDividerProps) {
  return <View style={[dividerStyles.line, style]} />;
}

const dividerStyles = StyleSheet.create({
  line: {
    height: layout.hairline,
    backgroundColor: palette.line,
    marginLeft: layout.screenPadding + layout.retailerMark + spacing.md,
  },
});
