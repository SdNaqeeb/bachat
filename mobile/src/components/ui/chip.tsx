/**
 * The selectable chip: categories in Settings, brands and sizes in Compare.
 *
 * Selection is carried by the current mode's accent, not by a checkmark, so a
 * rail of twenty categories reads as a block of colour at a glance rather than
 * twenty rows to scan. Because the accent is also the tab tint and the mode
 * switch thumb, a selected chip is visibly the same "on" as everything else.
 *
 * `ChipRail` exists because every one of these lists wraps differently and the
 * screens kept re-deriving the same gap. Horizontal when the list is a filter
 * bar, wrapped when it is a full picker.
 */

import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '@/components/ui/pressable-scale';
import { layout, palette, radius, spacing, type } from '@/theme';

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** The current mode's accent. Pass `useMode().accent.accent`. */
  accent?: string;
  /** Wash behind a selected chip. Pass `useMode().accent.wash`. */
  accentWash?: string;
  /** Trailing count or glyph, e.g. the number of deals in a category. */
  trailing?: ReactNode;
  /** Shows a small x on a selected chip, for a removable filter. */
  removable?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Chip({
  label,
  selected = false,
  onPress,
  accent = palette.accent,
  accentWash = palette.accentWash,
  trailing,
  removable = false,
  style,
}: ChipProps) {
  return (
    <PressableScale
      haptic="selection"
      activeScale={0.96}
      disabled={onPress === undefined}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: accentWash, borderColor: accent }
          : styles.chipIdle,
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
        style={[styles.label, { color: selected ? accent : palette.textSecondary }]}
      >
        {label}
      </Text>
      {removable && selected ? <Ionicons name="close" size={13} color={accent} /> : null}
      {trailing}
    </PressableScale>
  );
}

export type ChipRailProps = {
  children: ReactNode;
  /** `scroll` for a one-line filter bar, `wrap` for a full picker. */
  layout?: 'scroll' | 'wrap';
  style?: StyleProp<ViewStyle>;
};

export function ChipRail({ children, layout: mode = 'wrap', style }: ChipRailProps) {
  if (mode === 'wrap') {
    return <View style={[styles.wrap, style]}>{children}</View>;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.scrollContent}
      style={style}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 34,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: layout.hairline,
  },
  chipIdle: {
    backgroundColor: palette.surfaceRaised,
    borderColor: palette.line,
  },
  label: {
    ...type.label,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  scrollContent: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: layout.screenPadding,
  },
});
