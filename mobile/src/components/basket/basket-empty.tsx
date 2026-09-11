/**
 * The empty basket, which has to teach the feature rather than report a count.
 *
 * "No items yet" would be technically true and completely useless. The thing
 * the user has not yet understood is that Bachat is not a shopping list: it is
 * the five apps they currently open in sequence, collapsed into one number. So
 * this screen says that in one sentence, then gets out of the way by offering
 * the first few items as taps — a list with three things in it produces a real
 * comparison, and a real comparison explains the app better than any copy.
 *
 * The starters are deliberately the dullest possible groceries. The point is to
 * get to a working comparison in two taps, not to suggest a shopping trip.
 */

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Chip, ChipRail } from '@/components/ui/chip';
import { layout, palette, radius, spacing, type } from '@/theme';
import type { Mode } from '@/lib/types';

/** First-basket suggestions per mode. Dull on purpose — see the module doc. */
const STARTERS: Record<Mode, string[]> = {
  quick: [
    'Amul Taaza 500 ml',
    'Amul Butter 500 g',
    'Eggs, 6 pack',
    'Aashirvaad Atta 5 kg',
    'Toor dal 1 kg',
    'Tomato 1 kg',
  ],
  fashion: ['Plain navy tee, M', "Levi's 511, L", 'White sneakers, L', 'Oxford shirt, M'],
};

export type BasketEmptyProps = {
  mode: Mode;
  accent: string;
  accentWash: string;
  /** Adds one starter to the basket. Tapping again is harmless — it dedupes. */
  onAdd: (label: string) => void;
  /** Labels already in the basket, so a used starter reads as selected. */
  chosen: string[];
};

export function BasketEmpty({ mode, accent, accentWash, onAdd, chosen }: BasketEmptyProps) {
  return (
    <View style={styles.root}>
      <View style={styles.iconWrap}>
        <Ionicons name="basket-outline" size={30} color={accent} />
      </View>

      <Text accessibilityRole="header" maxFontSizeMultiplier={1.3} style={styles.headline}>
        Stop opening five apps
      </Text>

      <Text maxFontSizeMultiplier={1.4} style={styles.body}>
        {mode === 'quick'
          ? 'List what you actually buy each week. Bachat prices the whole basket at every quick-commerce app, adds their delivery and handling fees, and tells you which one is cheapest today.'
          : 'List the pieces you are shopping for. Bachat prices them at Myntra, Amazon and Flipkart together, so you stop checking each one by hand.'}
      </Text>

      <View style={styles.rule} />

      <Text maxFontSizeMultiplier={1.3} style={styles.prompt}>
        Tap a few to start — you can edit them any time.
      </Text>

      <ChipRail>
        {STARTERS[mode].map((label) => (
          <Chip
            key={label}
            label={label}
            selected={chosen.includes(label)}
            accent={accent}
            accentWash={accentWash}
            onPress={() => onAdd(label)}
          />
        ))}
      </ChipRail>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: layout.screenPadding,
    marginTop: spacing.lg,
    padding: spacing.xl,
    borderRadius: radius.xl,
    backgroundColor: palette.surface,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    gap: spacing.md,
  },
  iconWrap: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
  },
  headline: {
    ...type.title,
    color: palette.textPrimary,
  },
  body: {
    ...type.body,
    color: palette.textSecondary,
    maxWidth: layout.proseMaxWidth,
  },
  rule: {
    height: layout.hairline,
    backgroundColor: palette.line,
    marginVertical: spacing.sm,
  },
  prompt: {
    ...type.label,
    color: palette.textPrimary,
  },
});
