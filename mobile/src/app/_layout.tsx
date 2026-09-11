/**
 * Root layout: providers, the splash gate, and the single stack the tabs live in.
 *
 * Provider order is a dependency order, not a preference. `PrefsProvider` owns
 * the haptics flag and the stored push token, so `NotificationsProvider` sits
 * inside it. `ModeProvider` sits outside both because mode gates what the other
 * two are even about.
 *
 * The splash is held until fonts, the stored mode and the stored prefs are all
 * ready, so the first frame the user sees is the finished UI in the right mode's
 * colour rather than a system-font flash in the wrong one.
 */

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModeProvider, useMode } from '@/hooks/use-mode';
import { NotificationsProvider } from '@/hooks/use-notifications';
import { PrefsProvider, usePrefs } from '@/hooks/use-prefs';
import { palette } from '@/theme';
import { useAppFonts } from '@/theme/fonts';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ModeProvider>
          <PrefsProvider>
            <NotificationsProvider>
              <StatusBar style="dark" />
              <AppStack />
            </NotificationsProvider>
          </PrefsProvider>
        </ModeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppStack() {
  const [fontsLoaded, fontError] = useAppFonts();
  const { ready: modeReady } = useMode();
  const { ready: prefsReady } = usePrefs();

  // A missing font should degrade to the system face, never trap the user on
  // the splash screen.
  const ready = (fontsLoaded || Boolean(fontError)) && modeReady && prefsReady;

  const hideSplash = useCallback(() => {
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    if (ready) hideSplash();
  }, [hideSplash, ready]);

  if (!ready) return null;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.void },
        animation: 'fade',
      }}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.void },
});
