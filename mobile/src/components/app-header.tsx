/**
 * The header every tab shares.
 *
 * Two things, because there is only room for two: where you are, and which mode
 * you are in. The screen title sits left where the eye starts; the mode switch
 * sits right under the thumb, which is where it has to be in an app opened one-
 * handed at a kitchen counter twenty times a week.
 *
 * The header is a plain surface until the list scrolls under it, at which point
 * the caller passes `scrolled` and it grows a hairline. A permanent border on a
 * screen that starts at the top of its list is a line drawn for no reason.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModeSwitch } from '@/components/mode-switch';
import { layout, palette, spacing, type } from '@/theme';

/** Enough for "Fashion" at the largest font scale we honour. */
const SWITCH_WIDTH = 176;

export type AppHeaderProps = {
  title: string;
  /** Optional second line: a basket count, a result count, a sweep age. */
  subtitle?: string;
  /** Draws the bottom hairline. Wire to a scroll offset > 0. */
  scrolled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function AppHeader({ title, subtitle, scrolled = false, style }: AppHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + spacing.sm },
        scrolled && styles.headerScrolled,
        style,
      ]}
    >
      <View style={styles.titleBlock}>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          style={styles.title}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <ModeSwitch style={styles.switch} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    backgroundColor: palette.void,
  },
  headerScrolled: {
    borderBottomWidth: layout.hairline,
    borderBottomColor: palette.line,
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    ...type.title,
    color: palette.textPrimary,
  },
  subtitle: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.xxs,
  },
  switch: {
    width: SWITCH_WIDTH,
  },
});
