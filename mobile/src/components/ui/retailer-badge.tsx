/**
 * The retailer's mark on a price row.
 *
 * Bachat holds no retailer logos — shipping them would be a trademark problem
 * and a bundle cost for five 40px images. Instead each retailer gets a tinted
 * square with its initials, drawn from `Retailer.tint` and `Retailer.initials`.
 * That is recognisable at a glance down a column, which is all a comparison row
 * needs, and a new retailer costs one row of data rather than an asset.
 *
 * The tint is confined to this square. It never leaks into the surrounding row,
 * so a retailer's brand colour can never be mistaken for Bachat's own
 * save / stale / danger signals.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Retailer } from '@/lib/types';
import { fonts, layout, palette, spacing, type } from '@/theme';

export type RetailerBadgeProps = {
  retailer: Retailer;
  /** `mark` is the square alone; `full` adds the retailer's name beside it. */
  variant?: 'mark' | 'full';
  /** Square edge in px. Defaults to `layout.retailerMark`. */
  size?: number;
  /** Dims the badge, for a retailer that cannot supply the whole basket. */
  muted?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function RetailerBadge({
  retailer,
  variant = 'mark',
  size = layout.retailerMark,
  muted = false,
  style,
}: RetailerBadgeProps) {
  const square = (
    <View
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size * 0.28,
          backgroundColor: retailer.tint,
          opacity: muted ? 0.4 : 1,
        },
      ]}
    >
      <Text
        maxFontSizeMultiplier={1}
        style={[styles.initials, { fontSize: size * 0.38, lineHeight: size * 0.46 }]}
      >
        {retailer.initials}
      </Text>
    </View>
  );

  if (variant === 'mark') {
    return (
      <View accessible accessibilityLabel={retailer.name} style={style}>
        {square}
      </View>
    );
  }

  return (
    <View accessible accessibilityLabel={retailer.name} style={[styles.row, style]}>
      {square}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={[styles.name, muted && styles.nameMuted]}
      >
        {retailer.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: layout.hairline,
    // Keeps a pale retailer tint from dissolving into a white card.
    borderColor: 'rgba(17, 28, 24, 0.10)',
  },
  initials: {
    fontFamily: fonts.displayHeavy,
    color: palette.textInverse,
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  name: {
    ...type.subtitle,
    color: palette.textPrimary,
  },
  nameMuted: {
    color: palette.textSecondary,
  },
});
