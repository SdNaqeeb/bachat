/**
 * A route that is wired up but not yet built.
 *
 * Navigation, the header, the mode switch and the tab chrome are all real here
 * — only the body is pending. Keeping the placeholder in one component means
 * replacing it is a single import removal per screen, and it never accretes
 * layout the real screen would have to unpick.
 */

import { StyleSheet, View } from 'react-native';
import type { Ionicons } from '@expo/vector-icons';

import { AppHeader } from '@/components/app-header';
import { EmptyState } from '@/components/ui';
import { useMode } from '@/hooks/use-mode';
import { palette } from '@/theme';

export type ScreenPlaceholderProps = {
  title: string;
  /** What this screen will do, in the user's words. */
  purpose: string;
  icon?: keyof typeof Ionicons.glyphMap;
};

export function ScreenPlaceholder({ title, purpose, icon }: ScreenPlaceholderProps) {
  const { label } = useMode();

  return (
    <View style={styles.screen}>
      <AppHeader title={title} subtitle={label} />
      <EmptyState headline={`${title} is next`} caption={purpose} icon={icon} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.void,
  },
});
