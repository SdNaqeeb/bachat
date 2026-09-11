/**
 * Font loading for Bachat.
 *
 * The keys registered here are the literal `fontFamily` strings consumed by
 * `fonts` in ./tokens.ts — Archivo for numbers and headings, Manrope for body
 * copy. Keep the two files in sync; nothing else in the app calls `useFonts`.
 */

import { useFonts } from 'expo-font';

// Deep imports, not the package barrels: importing from '@expo-google-fonts/archivo'
// pulls all eighteen shipped faces into the bundle. Seven files instead of
// twenty-five keeps close to a megabyte out of the APK.
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_700Bold } from '@expo-google-fonts/archivo/700Bold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';

/** `[loaded, error]` — hold the splash until `loaded || error` is truthy. */
export type AppFontsState = [boolean, Error | null];

export function useAppFonts(): AppFontsState {
  const [loaded, error] = useFonts({
    Archivo_600SemiBold,
    Archivo_700Bold,
    Archivo_800ExtraBold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });

  return [loaded, error ?? null];
}
