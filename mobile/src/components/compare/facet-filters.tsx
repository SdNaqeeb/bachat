/**
 * Brand and size filters, fashion mode only.
 *
 * Myntra exposes brand and size as server-side facets (spec §3), which is the
 * whole reason this feature is cheap: changing a chip re-runs the search at the
 * retailer rather than filtering a page of results the app already holds. That
 * has a visible consequence — a filter tap costs a round trip — so the control
 * is built to make one deliberate change at a time rather than to be swept
 * through, and the summary line always states what is currently applied.
 *
 * In quick commerce this component is never rendered. "Size M" means nothing
 * for a kilo of onions, and a disabled filter bar is worse than no filter bar.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { Chip, ChipRail } from '@/components/ui/chip';
import { PressableScale } from '@/components/ui/pressable-scale';
import { layout, palette, radius, spacing, type } from '@/theme';

export type FacetFiltersProps = {
  brands: string[];
  sizes: string[];
  selectedBrands: string[];
  selectedSizes: string[];
  onToggleBrand: (brand: string) => void;
  onToggleSize: (size: string) => void;
  onClear: () => void;
  accent: string;
  accentWash: string;
};

export function FacetFilters({
  brands,
  sizes,
  selectedBrands,
  selectedSizes,
  onToggleBrand,
  onToggleSize,
  onClear,
  accent,
  accentWash,
}: FacetFiltersProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const active = selectedBrands.length + selectedSizes.length;

  const summary =
    active === 0
      ? 'Any brand, any size'
      : [
          selectedBrands.length > 0 ? selectedBrands.join(', ') : null,
          selectedSizes.length > 0 ? `size ${selectedSizes.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' — ');

  return (
    <View style={styles.root}>
      <PressableScale
        haptic="selection"
        activeScale={0.99}
        onPress={() => setOpen((previous) => !previous)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Filters. ${summary}`}
        style={styles.bar}
      >
        <Ionicons
          name="funnel-outline"
          size={16}
          color={active > 0 ? accent : palette.textSecondary}
        />
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          style={[styles.summary, active > 0 && { color: accent }]}
        >
          {summary}
        </Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={palette.textMuted}
        />
      </PressableScale>

      {open ? (
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(160)}
          exiting={reduceMotion ? undefined : FadeOut.duration(120)}
          style={styles.panel}
        >
          <Text maxFontSizeMultiplier={1.3} style={styles.groupLabel}>
            Brand
          </Text>
          <ChipRail>
            {brands.map((brand) => (
              <Chip
                key={brand}
                label={brand}
                removable
                selected={selectedBrands.includes(brand)}
                accent={accent}
                accentWash={accentWash}
                onPress={() => onToggleBrand(brand)}
              />
            ))}
          </ChipRail>

          <Text maxFontSizeMultiplier={1.3} style={styles.groupLabel}>
            Size
          </Text>
          <ChipRail>
            {sizes.map((size) => (
              <Chip
                key={size}
                label={size}
                removable
                selected={selectedSizes.includes(size)}
                accent={accent}
                accentWash={accentWash}
                onPress={() => onToggleSize(size)}
              />
            ))}
          </ChipRail>

          <Text maxFontSizeMultiplier={1.3} style={styles.note}>
            Filters run at the retailer, so each change fetches fresh results.
          </Text>

          {active > 0 ? (
            <PressableScale
              haptic="selection"
              onPress={onClear}
              accessibilityLabel="Clear all filters"
              style={styles.clear}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.clearLabel}>
                Clear filters
              </Text>
            </PressableScale>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: layout.screenPadding,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    overflow: 'hidden',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  summary: {
    flex: 1,
    ...type.label,
    color: palette.textSecondary,
  },
  panel: {
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: layout.hairline,
    borderTopColor: palette.line,
    backgroundColor: palette.surfaceRaised,
  },
  groupLabel: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.xs,
  },
  note: {
    ...type.caption,
    color: palette.textMuted,
    marginTop: spacing.xs,
  },
  clear: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
  },
  clearLabel: {
    ...type.label,
    color: palette.danger,
  },
});
