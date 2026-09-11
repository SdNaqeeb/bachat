/**
 * One retailer's matches for a search, under a header stating its best price.
 *
 * Grouping is by retailer rather than one flat cheapest-first list because the
 * decision at the end of a search is still "which app do I open" — the same
 * decision the Basket screen answers. A flat list interleaving four retailers
 * makes the user re-derive that grouping in their head on every scan.
 *
 * The group header carries the retailer's best price and the age of these rows,
 * so a collapsed-looking scan down the headers alone answers the question. Each
 * row underneath is the shared `PriceRow`, so a search result and a basket line
 * look and behave identically.
 */

import { StyleSheet, Text, View } from 'react-native';

import { PriceRow, RowDivider } from '@/components/ui/price-row';
import { PriceText } from '@/components/ui/price-text';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { StalenessChip } from '@/components/ui/staleness-chip';
import type { Mode, Offer, Retailer } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

export type RetailerGroupProps = {
  retailer: Retailer;
  /** This retailer's offers, cheapest first, in-stock before out-of-stock. */
  offers: Offer[];
  mode: Mode;
  /** True when this retailer holds the cheapest in-stock offer overall. */
  cheapest: boolean;
  onOpen: (offer: Offer) => void;
};

export function RetailerGroup({
  retailer,
  offers,
  mode,
  cheapest,
  onOpen,
}: RetailerGroupProps) {
  const best = offers.find((offer) => offer.inStock) ?? offers[0];
  if (!best) return null;

  const oldest = Math.min(...offers.map((offer) => offer.capturedAt).filter((at) => at > 0));

  return (
    <View style={styles.group}>
      <View style={styles.header}>
        <RetailerBadge retailer={retailer} variant="full" size={28} />
        <View style={styles.headerMeta}>
          {Number.isFinite(oldest) ? (
            <StalenessChip capturedAt={oldest} mode={mode} bare />
          ) : null}
        </View>
        <View style={styles.headerPrice}>
          <Text maxFontSizeMultiplier={1.2} style={styles.fromLabel}>
            {cheapest ? 'Cheapest here' : 'From'}
          </Text>
          <PriceText amount={best.price} size="small" win={cheapest} />
        </View>
      </View>

      {offers.map((offer, index) => (
        <View key={offer.productId}>
          {index > 0 ? <RowDivider /> : null}
          <PriceRow
            offer={offer}
            retailer={retailer}
            win={cheapest && offer === best && offer.inStock}
            onPress={() => onOpen(offer)}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: palette.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: palette.surfaceRaised,
  },
  headerMeta: {
    flex: 1,
  },
  headerPrice: {
    alignItems: 'flex-end',
  },
  fromLabel: {
    ...type.tag,
    color: palette.textMuted,
  },
});
