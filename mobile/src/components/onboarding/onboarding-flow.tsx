/**
 * First run, in four steps (spec §10).
 *
 * Bachat is useless until four things are true: it knows which dark store to
 * price against, it knows which categories you care about, it is allowed to
 * notify you, and the phone's battery manager has been told to let those
 * notifications through. Every one of them is a setting the user would
 * otherwise have to discover, so they are walked once, in the order that each
 * depends on the last.
 *
 * This is one of the two places in the app where numbered steps are honest —
 * the content genuinely is a sequence with a beginning and an end. Every step
 * can be skipped: a setup flow that cannot be escaped is a wall in front of the
 * product, and every one of these settings is reachable again in Settings.
 *
 * The battery step is deliberately last and deliberately blunt. It is the only
 * step that asks the user to leave the app, and it earns that by explaining
 * that the alternative is alerts that silently never arrive.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { BatteryGuide } from '@/components/settings/battery-guide';
import { CategoryPicker } from '@/components/settings/category-picker';
import { LocationCard } from '@/components/settings/location-card';
import { Button } from '@/components/ui/button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { useMode } from '@/hooks/use-mode';
import { useNotifications } from '@/hooks/use-notifications';
import { usePrefs } from '@/hooks/use-prefs';
import { apiClient } from '@/lib/client';
import type { Category } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

const STEP_COUNT = 4;

export type OnboardingFlowProps = {
  /** Called when the flow is finished or skipped. The caller closes the modal. */
  onDone: () => void;
};

export function OnboardingFlow({ onDone }: OnboardingFlowProps) {
  const insets = useSafeAreaInsets();
  const { mode, label, accent } = useMode();
  const { prefs, update, updateSettings, toggleCategory } = usePrefs();
  const { permission, busy, error, enable, ensureChannels } = useNotifications();

  const [step, setStep] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .facets(mode, controller.signal)
      .then((facets) => setCategories(facets.categories))
      .catch(() => {
        // The category step degrades to a skip rather than blocking setup.
      });
    return () => controller.abort();
  }, [mode]);

  const finish = useCallback(() => {
    updateSettings({ batteryGuideDone: true });
    onDone();
  }, [updateSettings, onDone]);

  const next = useCallback(() => {
    setStep((previous) => {
      if (previous + 1 >= STEP_COUNT) {
        finish();
        return previous;
      }
      return previous + 1;
    });
  }, [finish]);

  const turnOnAlerts = useCallback(async () => {
    const granted = await enable();
    if (granted) {
      await ensureChannels(categories);
      update({ notificationsEnabled: true });
    }
    next();
  }, [enable, ensureChannels, categories, update, next]);

  const enabledHere = useMemo(
    () => categories.filter((category) => prefs.enabledCategories.includes(category.id)),
    [categories, prefs.enabledCategories]
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.lg }]}>
      <View style={styles.progressRow}>
        {Array.from({ length: STEP_COUNT }, (_, index) => (
          <View
            key={index}
            style={[
              styles.progressBar,
              { backgroundColor: index <= step ? accent.accent : palette.surfacePressed },
            ]}
          />
        ))}
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxxl }]}
      >
        {step === 0 ? (
          <Step
            title="Where do you order from?"
            body="Quick-commerce prices are set per dark store, so the same milk costs different amounts two neighbourhoods apart. Bachat needs your pincode to price the right one."
          >
            <LocationCard
              pincode={prefs.pincode}
              lat={prefs.lat}
              lon={prefs.lon}
              accent={accent.accent}
              onChange={update}
            />
          </Step>
        ) : null}

        {step === 1 ? (
          <Step
            title="What do you buy?"
            body={`These ${label.toLowerCase()} categories decide what Bachat sweeps, what shows up in Deals, and which alerts are allowed to reach you.`}
          >
            <CategoryPicker
              categories={categories}
              enabled={prefs.enabledCategories}
              accent={accent.accent}
              accentWash={accent.wash}
              onToggle={toggleCategory}
              onSelectAll={() =>
                update({
                  enabledCategories: [
                    ...new Set([
                      ...prefs.enabledCategories,
                      ...categories.map((category) => category.id),
                    ]),
                  ],
                })
              }
            />
          </Step>
        ) : null}

        {step === 2 ? (
          <Step
            title="Should Bachat tell you about a drop?"
            body="Alerts fire when something you follow hits a deep discount or the lowest price Bachat has recorded. They are held during quiet hours rather than dropped."
          >
            {permission === 'granted' ? (
              <View style={styles.granted}>
                <Ionicons name="checkmark-circle" size={20} color={palette.save} />
                <Text maxFontSizeMultiplier={1.3} style={styles.grantedText}>
                  Alerts are on for {enabledHere.length} categories.
                </Text>
              </View>
            ) : (
              <Button
                label="Turn on alerts"
                icon="notifications-outline"
                loading={busy}
                onPress={() => void turnOnAlerts()}
              />
            )}
            {error ? (
              <Text maxFontSizeMultiplier={1.4} style={styles.error}>
                {error}
              </Text>
            ) : null}
          </Step>
        ) : null}

        {step === 3 ? (
          <Step
            title="One thing your phone does"
            body="This is the step people skip and then wonder why alerts stopped. It takes about a minute and only has to be done once."
          >
            <BatteryGuide showDone={false} />
          </Step>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <PressableScale
          haptic="tap"
          onPress={step === STEP_COUNT - 1 ? finish : onDone}
          accessibilityLabel={step === STEP_COUNT - 1 ? 'Finish setup' : 'Skip setup'}
          style={styles.skip}
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.skipLabel}>
            {step === STEP_COUNT - 1 ? 'Skip this' : 'Set this up later'}
          </Text>
        </PressableScale>

        <Button
          label={step === STEP_COUNT - 1 ? 'Start using Bachat' : 'Next'}
          tone="accent"
          accentColor={accent.accent}
          onPress={step === STEP_COUNT - 1 ? finish : next}
        />
      </View>
    </View>
  );
}

type StepProps = {
  title: string;
  body: string;
  children: React.ReactNode;
};

function Step({ title, body, children }: StepProps) {
  return (
    <View style={styles.step}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={1.2} style={styles.stepTitle}>
        {title}
      </Text>
      <Text maxFontSizeMultiplier={1.4} style={styles.stepBody}>
        {body}
      </Text>
      <View style={styles.stepControl}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.void,
  },
  progressRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.lg,
  },
  progressBar: {
    flex: 1,
    height: 3,
    borderRadius: spacing.xxs,
  },
  content: {
    paddingHorizontal: layout.screenPadding,
  },
  step: {
    gap: spacing.md,
  },
  stepTitle: {
    ...type.title,
    color: palette.textPrimary,
  },
  stepBody: {
    ...type.body,
    color: palette.textSecondary,
    maxWidth: layout.proseMaxWidth,
  },
  stepControl: {
    marginTop: spacing.md,
  },
  granted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  grantedText: {
    ...type.bodyStrong,
    color: palette.textPrimary,
  },
  error: {
    ...type.caption,
    color: palette.danger,
    marginTop: spacing.md,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    borderTopWidth: layout.hairline,
    borderTopColor: palette.line,
    backgroundColor: palette.void,
  },
  skip: {
    paddingVertical: spacing.md,
    paddingRight: spacing.md,
  },
  skipLabel: {
    ...type.label,
    color: palette.textSecondary,
  },
});
