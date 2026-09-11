/**
 * Text entry, in the three shapes this app needs: a search bar, a settings
 * value, and a rupee amount.
 *
 * The focus ring is the current mode's accent, matching the chips and the tab
 * bar, so "focused" and "selected" look like the same state everywhere. There
 * is no floating label: every field here sits under a heading that already
 * names it, and a label that animates into a border is motion spent on the
 * least interesting moment in the app.
 *
 * `NumberField` is fully controlled and formats nothing. A fee field that
 * rewrites "4" to "₹4" while you are typing "45" is the single most irritating
 * control a settings screen can have, so the rupee sign lives outside the input
 * and the input itself only ever holds digits.
 */

import { useCallback, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { IconButton } from '@/components/ui/button';
import { fonts, layout, palette, radius, spacing, type } from '@/theme';

export type TextFieldProps = Omit<TextInputProps, 'style' | 'value' | 'onChangeText'> & {
  value: string;
  onChangeText: (next: string) => void;
  /** Leading glyph. A search field gets one; a settings value does not. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** The current mode's accent, used for the focus ring. */
  accent?: string;
  /** Shows a clear button once there is something to clear. */
  clearable?: boolean;
  /** Right-hand slot: a unit, a "Use my location" button. */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function TextField({
  value,
  onChangeText,
  icon,
  accent = palette.accent,
  clearable = false,
  trailing,
  style,
  ...rest
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.field,
        focused ? { borderColor: accent, backgroundColor: palette.surface } : styles.idle,
        style,
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={18}
          color={focused ? accent : palette.textMuted}
        />
      ) : null}

      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholderTextColor={palette.textMuted}
        selectionColor={accent}
        maxFontSizeMultiplier={1.3}
        style={styles.input}
        {...rest}
      />

      {clearable && value.length > 0 ? (
        <IconButton icon="close-circle" label="Clear" onPress={() => onChangeText('')} />
      ) : null}
      {trailing}
    </View>
  );
}

export type NumberFieldProps = {
  value: number;
  onChange: (next: number) => void;
  /** Sits inside the field ahead of the digits, e.g. '₹'. */
  prefix?: string;
  placeholder?: string;
  accent?: string;
  /** Spoken label — these fields sit in a grid where the header is far away. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** A whole-rupee amount. Used for the per-retailer fees in Settings (spec §8). */
export function NumberField({
  value,
  onChange,
  prefix = '₹',
  placeholder = '0',
  accent = palette.accent,
  accessibilityLabel,
  style,
}: NumberFieldProps) {
  const [focused, setFocused] = useState(false);
  // Zero renders as the placeholder rather than a literal "0": an unset fee and
  // a zero fee are the same thing here, and "0" invites a pointless edit.
  const text = value > 0 ? String(value) : '';

  const commit = useCallback(
    (next: string) => {
      const digits = next.replace(/[^0-9]/g, '');
      onChange(digits.length > 0 ? Number(digits) : 0);
    },
    [onChange]
  );

  return (
    <View
      style={[
        styles.field,
        styles.number,
        focused ? { borderColor: accent, backgroundColor: palette.surface } : styles.idle,
        style,
      ]}
    >
      <Text maxFontSizeMultiplier={1.2} style={styles.prefix}>
        {prefix}
      </Text>
      <TextInput
        value={text}
        onChangeText={commit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={palette.textMuted}
        selectionColor={accent}
        accessibilityLabel={accessibilityLabel}
        maxFontSizeMultiplier={1.2}
        style={[styles.input, styles.numberInput]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: layout.hairline,
  },
  idle: {
    backgroundColor: palette.surfaceRaised,
    borderColor: palette.line,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.sm,
    ...type.body,
    color: palette.textPrimary,
  },
  number: {
    minHeight: 42,
    gap: spacing.xxs,
  },
  numberInput: {
    fontFamily: fonts.displayMedium,
    fontVariant: ['tabular-nums'],
  },
  prefix: {
    ...type.priceSmall,
    color: palette.textMuted,
  },
});
