/**
 * The three buttons Bachat has, and no more.
 *
 * `primary` is the one action a screen wants you to take — almost always
 * "open the retailer's app and buy". It is ink, not green: green in this app
 * means money, and a green button would be the only green thing on screen that
 * is not a price. `accent` takes the current mode's hue for actions that are
 * about the app itself (enable notifications, save a filter). `quiet` is a
 * hairline ghost for the secondary half of a pair.
 *
 * Buttons state what happens when pressed, in the same words the result uses
 * ("Open Blinkit" -> Blinkit opens). No trailing arrows: the label already says
 * it leaves the app.
 */

import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PressableScale } from '@/components/ui/pressable-scale';
import { layout, palette, radius, spacing, type } from '@/theme';

export type ButtonTone = 'primary' | 'accent' | 'quiet' | 'danger';
export type ButtonSize = 'md' | 'sm';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  size?: ButtonSize;
  /** Leading glyph. Keep it literal — a cart for buying, a bell for alerts. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Fills the width of its parent. The buy button always does. */
  block?: boolean;
  loading?: boolean;
  disabled?: boolean;
  /** Overrides the fill for `accent`, so a screen can pass `useMode().accent`. */
  accentColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  onPress,
  tone = 'primary',
  size = 'md',
  icon,
  block = false,
  loading = false,
  disabled = false,
  accentColor,
  style,
}: ButtonProps) {
  const quiet = tone === 'quiet';
  const fill =
    tone === 'accent'
      ? (accentColor ?? palette.accent)
      : tone === 'danger'
        ? palette.dangerWash
        : palette.ink;
  const ink = quiet
    ? palette.textPrimary
    : tone === 'danger'
      ? palette.danger
      : palette.textInverse;

  return (
    <PressableScale
      haptic="selection"
      activeScale={block ? 0.985 : 0.97}
      disabled={disabled || loading}
      onPress={onPress}
      accessibilityLabel={label}
      style={[
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        quiet ? styles.quiet : { backgroundColor: fill },
        block && styles.block,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={ink} />
      ) : (
        <View style={styles.inner}>
          {icon ? <Ionicons name={icon} size={size === 'sm' ? 15 : 17} color={ink} /> : null}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.2}
            style={[size === 'sm' ? styles.labelSm : styles.label, { color: ink }]}
          >
            {label}
          </Text>
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  md: {
    minHeight: 48,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  sm: {
    minHeight: 36,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  quiet: {
    backgroundColor: palette.surface,
    borderWidth: layout.hairline,
    borderColor: palette.lineStrong,
  },
  block: {
    alignSelf: 'stretch',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  label: {
    ...type.bodyStrong,
  },
  labelSm: {
    ...type.label,
  },
});

export type IconButtonProps = {
  icon: keyof typeof Ionicons.glyphMap;
  /** Spoken label — an icon alone tells a screen reader nothing. */
  label: string;
  onPress: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A 40px tap target for row-level actions: remove an item, clear a field. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'default',
  disabled = false,
  style,
}: IconButtonProps) {
  return (
    <PressableScale
      haptic="tap"
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={spacing.sm}
      style={[iconStyles.button, style]}
    >
      <Ionicons
        name={icon}
        size={18}
        color={tone === 'danger' ? palette.danger : palette.textSecondary}
      />
    </PressableScale>
  );
}

const iconStyles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
});
