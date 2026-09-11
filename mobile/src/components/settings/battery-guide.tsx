/**
 * The OEM battery-manager step (spec §10).
 *
 * This is the honest part of the app. Xiaomi/MIUI, OnePlus, Samsung, Realme and
 * their relatives ship aggressive battery managers that drop FCM wake
 * broadcasts for apps the user has not explicitly exempted. Firebase still
 * reports the message as delivered. There is no code change in Bachat, or in
 * any other app, that fixes this — which is exactly why it is surfaced here as
 * a guided step rather than buried, and why the copy says plainly that it is
 * the phone's behaviour and not a bug in Bachat.
 *
 * Detection reads `expo-device`'s manufacturer and falls back to
 * `Platform.constants`, which is what an Android build exposes natively. An
 * unrecognised manufacturer gets the generic Android instructions rather than a
 * shrug — the doze exemption alone helps on stock Android too.
 *
 * Every deep link is a best effort: OEM settings activities are renamed between
 * skin versions and an intent that resolved on MIUI 13 may not on MIUI 14. Each
 * profile therefore carries a chain — the specific activity, then Android's own
 * battery-optimisation screen, then this app's settings page — and the written
 * steps stay on screen so the user can always get there by hand.
 */

import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import { Ionicons } from '@expo/vector-icons';

import { Button } from '@/components/ui/button';
import { layout, palette, radius, spacing, type } from '@/theme';

import {
  isAggressiveOem,
  profileFor,
  type IntentAttempt,
  type OemProfile,
} from '@/lib/oem-profiles';

export type { OemProfile };
export { profileFor, isAggressiveOem };

/** Reads the manufacturer from expo-device, then from the RN platform constants. */
export function detectManufacturer(): string {
  const fromDevice = `${Device.manufacturer ?? ''} ${Device.brand ?? ''}`.trim();
  if (fromDevice.length > 0) return fromDevice;

  if (Platform.OS === 'android') {
    const constants = Platform.constants as { Manufacturer?: string; Brand?: string };
    return `${constants.Manufacturer ?? ''} ${constants.Brand ?? ''}`.trim();
  }
  return '';
}

export type BatteryGuideProps = {
  /** Marks the step done, so onboarding and Settings agree it has been walked. */
  onDone?: () => void;
  /** Hides the "I've done this" button when the guide is shown for reference. */
  showDone?: boolean;
};

export function BatteryGuide({ onDone, showDone = true }: BatteryGuideProps) {
  const manufacturer = useMemo(() => detectManufacturer(), []);
  const profile = useMemo(() => profileFor(manufacturer), [manufacturer]);
  const [failed, setFailed] = useState(false);

  const open = useCallback(async () => {
    setFailed(false);
    const packageName = Application.applicationId ?? 'ai.smartlearners.bachat';
    const attempts: IntentAttempt[] = [
      ...profile.intents,
      {
        action: IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        params: { data: `package:${packageName}` },
      },
    ];

    for (const attempt of attempts) {
      try {
        await IntentLauncher.startActivityAsync(attempt.action, attempt.params);
        return;
      } catch {
        // OEM activities get renamed between skin versions; try the next one.
      }
    }
    setFailed(true);
  }, [profile]);

  return (
    <View style={styles.root}>
      <View style={styles.plainly}>
        <Ionicons name="battery-half-outline" size={18} color={palette.stale} />
        <Text maxFontSizeMultiplier={1.4} style={styles.plainlyText}>
          {isAggressiveOem(profile)
            ? `Your phone's battery manager can stop alerts reaching you even when Bachat and Firebase both think they were delivered. No app can fix that from code — it has to be switched off here, once.`
            : `Android's doze mode can delay alerts when the phone has been idle for a while. Exempting Bachat once keeps price drops arriving on time.`}
        </Text>
      </View>

      <Text maxFontSizeMultiplier={1.3} style={styles.detected}>
        {manufacturer.length > 0
          ? `Detected ${manufacturer} — these are the steps for ${profile.label}.`
          : `Showing the general Android steps.`}
      </Text>

      <View style={styles.steps}>
        {profile.steps.map((step, index) => (
          <View key={step} style={styles.step}>
            <View style={styles.stepNumber}>
              <Text maxFontSizeMultiplier={1.2} style={styles.stepNumberText}>
                {index + 1}
              </Text>
            </View>
            <Text maxFontSizeMultiplier={1.4} style={styles.stepText}>
              {step}
            </Text>
          </View>
        ))}
      </View>

      {failed ? (
        <Text maxFontSizeMultiplier={1.4} style={styles.failed}>
          This phone would not open that screen directly — its settings app names it
          something else. Follow the steps above by hand instead.
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button label="Open these settings" icon="open-outline" size="sm" onPress={open} />
        {showDone && onDone ? (
          <Button label="I've done this" tone="quiet" size="sm" onPress={onDone} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
  },
  plainly: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: palette.staleWash,
  },
  plainlyText: {
    flex: 1,
    ...type.caption,
    color: palette.textSecondary,
  },
  detected: {
    ...type.label,
    color: palette.textPrimary,
  },
  steps: {
    gap: spacing.md,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  stepNumber: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceRaised,
    borderWidth: layout.hairline,
    borderColor: palette.line,
  },
  stepNumberText: {
    ...type.tag,
    color: palette.textSecondary,
  },
  stepText: {
    flex: 1,
    ...type.body,
    color: palette.textSecondary,
  },
  failed: {
    ...type.caption,
    color: palette.danger,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
