/**
 * The page grammar shared by all four screens: a quiet heading on the sage
 * ground, then a white card holding hairline-divided rows.
 *
 * Everything in Bachat is a table of some kind — quotes, deals, search results,
 * settings — so rather than give each screen its own container, they all use
 * this one. That is what makes Settings feel like the same app as Basket
 * instead of a different developer's screen.
 *
 * The heading takes a trailing slot rather than a subtitle line, because the
 * useful thing to put beside a heading is nearly always a count, an age or an
 * action, and stacking that under the title wastes a row on a dense screen.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { layout, palette, radius, spacing, type } from '@/theme';

export type SectionHeadingProps = {
  title: string;
  /** One line of context under the title. Used sparingly. */
  caption?: string;
  /** Right-hand slot: a count, a staleness chip, an "Edit" pressable. */
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function SectionHeading({ title, caption, trailing, style }: SectionHeadingProps) {
  return (
    <View style={[styles.heading, style]}>
      <View style={styles.headingText}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.3} style={styles.title}>
          {title}
        </Text>
        {caption ? (
          <Text maxFontSizeMultiplier={1.3} style={styles.caption}>
            {caption}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

export type SectionCardProps = {
  children: ReactNode;
  /** Removes the internal padding, for a card that holds full-bleed rows. */
  flush?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function SectionCard({ children, flush = false, style }: SectionCardProps) {
  return <View style={[styles.card, flush ? styles.flush : styles.padded, style]}>{children}</View>;
}

export type SettingRowProps = {
  label: string;
  /** Why this setting matters, or what the current value means. */
  hint?: string;
  /** The control: a switch, a value, a chevron. */
  trailing?: ReactNode;
  /** Renders under the label and control, full width — a slider, a chip rail. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** One labelled control inside a {@link SectionCard}. */
export function SettingRow({ label, hint, trailing, children, style }: SettingRowProps) {
  return (
    <View style={[styles.row, style]}>
      <View style={styles.rowTop}>
        <View style={styles.rowText}>
          <Text maxFontSizeMultiplier={1.4} style={styles.rowLabel}>
            {label}
          </Text>
          {hint ? (
            <Text maxFontSizeMultiplier={1.4} style={styles.rowHint}>
              {hint}
            </Text>
          ) : null}
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.md,
  },
  headingText: {
    flex: 1,
  },
  title: {
    ...type.subtitle,
    color: palette.textPrimary,
  },
  caption: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.xxs,
  },
  card: {
    marginHorizontal: layout.screenPadding,
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    overflow: 'hidden',
  },
  padded: {
    padding: spacing.lg,
  },
  flush: {
    padding: 0,
  },
  row: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    ...type.bodyStrong,
    color: palette.textPrimary,
  },
  rowHint: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.xxs,
  },
});
