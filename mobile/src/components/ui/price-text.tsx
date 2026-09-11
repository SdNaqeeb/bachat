/**
 * Every rupee amount on screen.
 *
 * Three jobs, one component: the big number (`hero`), the row number
 * (`default`), and the quiet supporting number (`small`). All of them set
 * tabular figures via `type.price*`, so a column of prices lines up digit for
 * digit down a list — the whole point of a comparison screen.
 *
 * `strike` renders an MRP: struck through, muted, never emphasised. The price
 * the user pays is always the loudest thing in the pair.
 */

import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { rupees } from '@/lib/format';
import { palette, spacing, type } from '@/theme';

export type PriceSize = 'hero' | 'default' | 'small';

export type PriceTextProps = {
  amount: number;
  size?: PriceSize;
  /** Overrides the colour. Defaults to ink, or `palette.save` when `win`. */
  color?: string;
  /** Marks this as the winning/cheapest price: green, and announced as such. */
  win?: boolean;
  /** Force paise. By default they show only when the amount has them. */
  paise?: boolean;
  style?: StyleProp<TextStyle>;
};

const SIZE_STYLE: Record<PriceSize, TextStyle> = {
  hero: type.priceHero,
  default: type.price,
  small: type.priceSmall,
};

export function PriceText({
  amount,
  size = 'default',
  color,
  win = false,
  paise,
  style,
}: PriceTextProps) {
  const resolved = color ?? (win ? palette.save : palette.textPrimary);
  const text = rupees(amount, paise === undefined ? undefined : { paise });

  return (
    <Text
      accessibilityLabel={win ? `${text}, cheapest` : text}
      // Prices must never reflow a row, however large the user's font setting.
      maxFontSizeMultiplier={1.2}
      numberOfLines={1}
      style={[SIZE_STYLE[size], { color: resolved }, style]}
    >
      {text}
    </Text>
  );
}

export type StrikePriceProps = {
  /** The MRP. Renders nothing when null or not above `price`. */
  mrp: number | null;
  /** The price actually charged, used to suppress a meaningless strike. */
  price: number;
  style?: StyleProp<TextStyle>;
};

/** Struck-through MRP. Renders nothing when there is no genuine markdown. */
export function StrikePrice({ mrp, price, style }: StrikePriceProps) {
  if (mrp === null || mrp <= price) return null;
  return (
    <Text
      accessibilityLabel={`Maximum retail price ${rupees(mrp)}`}
      maxFontSizeMultiplier={1.2}
      numberOfLines={1}
      style={[styles.strike, style]}
    >
      {rupees(mrp)}
    </Text>
  );
}

export type PriceStatProps = {
  /** What the number means: 'Delivery', 'You save', 'Basket total'. */
  label: string;
  amount: number;
  size?: PriceSize;
  win?: boolean;
  /** Right-aligns the pair, for the trailing column of a row. */
  align?: 'left' | 'right';
  style?: StyleProp<ViewStyle>;
};

/** A labelled amount: the fee lines and the saving callout are both this. */
export function PriceStat({
  label,
  amount,
  size = 'small',
  win = false,
  align = 'left',
  style,
}: PriceStatProps) {
  return (
    <View style={[align === 'right' && styles.right, style]}>
      <Text maxFontSizeMultiplier={1.3} style={styles.statLabel}>
        {label}
      </Text>
      <PriceText amount={amount} size={size} win={win} />
    </View>
  );
}

const styles = StyleSheet.create({
  strike: {
    ...type.priceSmall,
    color: palette.textMuted,
    textDecorationLine: 'line-through',
  },
  right: {
    alignItems: 'flex-end',
  },
  statLabel: {
    ...type.caption,
    color: palette.textSecondary,
    marginBottom: spacing.xxs,
  },
});
