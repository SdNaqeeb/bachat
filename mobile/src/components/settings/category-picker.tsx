/**
 * Which categories Bachat sweeps and alerts on, for the current mode.
 *
 * This is the highest-consequence control in Settings and the copy says so: the
 * same list gates the Deals feed *and* which notifications are allowed to wake
 * the phone (spec §7). A user who turns off "Snacks" here and still gets a
 * snacks alert has lost trust in the whole app, so the two are wired to one
 * setting rather than two.
 *
 * Only the current mode's categories are shown. A single flat list of eleven
 * mixed grocery and clothing categories would need a mode column to make sense,
 * and the header switch already is that column.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Chip, ChipRail } from '@/components/ui/chip';
import { PressableScale } from '@/components/ui/pressable-scale';
import type { Category } from '@/lib/types';
import { palette, spacing, type } from '@/theme';

export type CategoryPickerProps = {
  categories: Category[];
  enabled: string[];
  onToggle: (categoryId: string) => void;
  /** Turns every category in this mode on at once. */
  onSelectAll: () => void;
  accent: string;
  accentWash: string;
};

export function CategoryPicker({
  categories,
  enabled,
  onToggle,
  onSelectAll,
  accent,
  accentWash,
}: CategoryPickerProps) {
  const on = categories.filter((category) => enabled.includes(category.id)).length;
  const allOn = on === categories.length && categories.length > 0;

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Text maxFontSizeMultiplier={1.3} style={styles.summary}>
          {on === 0
            ? 'Nothing followed — you will get no deals and no alerts.'
            : `${on} of ${categories.length} followed.`}
        </Text>
        {allOn ? null : (
          <PressableScale
            haptic="selection"
            onPress={onSelectAll}
            accessibilityLabel="Follow every category"
            style={styles.all}
          >
            <Text maxFontSizeMultiplier={1.2} style={[styles.allLabel, { color: accent }]}>
              Follow all
            </Text>
          </PressableScale>
        )}
      </View>

      <ChipRail>
        {categories.map((category) => (
          <Chip
            key={category.id}
            label={category.label}
            selected={enabled.includes(category.id)}
            accent={accent}
            accentWash={accentWash}
            onPress={() => onToggle(category.id)}
          />
        ))}
      </ChipRail>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  summary: {
    flex: 1,
    ...type.caption,
    color: palette.textSecondary,
  },
  all: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  allLabel: {
    ...type.label,
  },
});
