/**
 * Settings — everything that changes what the other three screens say.
 *
 * The order is by consequence, not by convention. Notification delivery health
 * is first because it is the only setting that can be silently broken by the
 * phone rather than by the user (spec §10), and a user who does not know their
 * alerts are being dropped has no reason to come looking for a setting. After
 * that come the controls that shape the feed and the ranking — categories, the
 * threshold, quiet hours, fees — and the device-level preferences last.
 *
 * Categories, and only categories, are per mode: the header switch is the mode
 * column. The fees, the threshold and the location are global because a fee is
 * a fee whichever shop it belongs to.
 *
 * Every write goes through `usePrefs`, which persists locally first and syncs
 * to the Worker behind a debounce. That ordering matters on a phone with no
 * signal at the back of a kitchen: the setting must change now, and reach the
 * server whenever it can.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { AppHeader } from '@/components/app-header';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { BatteryGuide } from '@/components/settings/battery-guide';
import { CategoryPicker } from '@/components/settings/category-picker';
import { DeliveryHealth } from '@/components/settings/delivery-health';
import { FeeEditor } from '@/components/settings/fee-editor';
import { LocationCard } from '@/components/settings/location-card';
import { QuietHoursControl } from '@/components/settings/quiet-hours-control';
import { ThresholdControl } from '@/components/settings/threshold-control';
import { Button, SectionCard, SectionHeading, SettingRow, Skeleton } from '@/components/ui';
import { useMode } from '@/hooks/use-mode';
import { useNotifications } from '@/hooks/use-notifications';
import { usePrefs } from '@/hooks/use-prefs';
import { apiClient } from '@/lib/client';
import type { Category, Facets, HealthReport } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

export default function SettingsScreen() {
  const { mode, label, accent } = useMode();
  const { prefs, settings, update, updateSettings, toggleCategory, setFees, reset, syncError } =
    usePrefs();
  const { permission, busy, error, enable, ensureChannels, lastReceivedAt } = useNotifications();

  const [facets, setFacets] = useState<Facets | null>(null);
  const [catalog, setCatalog] = useState<Category[] | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [batteryOpen, setBatteryOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .facets(mode, controller.signal)
      .then(setFacets)
      .catch(() => {
        // Losing facets costs the retailer/fee lists, not the whole screen.
      });
    return () => controller.abort();
  }, [mode]);

  // Categories come from the CATALOG, not from facets.
  //
  // `facets.categories` is derived from rows already in `products`, so for a
  // mode nothing has been swept for it comes back empty — and this picker is
  // how you enable the categories that would cause that sweep. Feeding it from
  // facets deadlocks: quick commerce had no products, so the picker offered no
  // quick categories, so none could be enabled, so the sweep collected
  // nothing. /api/categories is the catalog and exists independently of what
  // has been collected.
  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .categories(mode, controller.signal)
      .then(setCatalog)
      .catch(() => {
        // Falls back to the facets list below, which is better than nothing.
      });
    return () => controller.abort();
  }, [mode]);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .health(controller.signal)
      .then(setHealth)
      // A server that cannot be reached is itself a delivery-health answer: the
      // card falls back to "never sent", which is honest.
      .catch(() => setHealth(null));
    return () => controller.abort();
  }, []);

  // Channels must exist before a push can land in one, and they are named after
  // the categories, so they are re-asserted whenever that list is known.
  useEffect(() => {
    if (!facets) return;
    void ensureChannels(facets.categories);
  }, [facets, ensureChannels]);

  // Catalog first; the facets list is only a fallback for an unreachable
  // /api/categories, and is filtered to this mode since facets already is.
  const categories = useMemo(
    () => catalog ?? facets?.categories ?? [],
    [catalog, facets]
  );
  const retailers = useMemo(() => facets?.retailers ?? [], [facets]);

  const followAll = useCallback(() => {
    update({
      enabledCategories: [
        ...new Set([...prefs.enabledCategories, ...categories.map((category) => category.id)]),
      ],
    });
  }, [update, prefs.enabledCategories, categories]);

  const turnOnAlerts = useCallback(() => {
    void enable().then((granted) => {
      if (granted) update({ notificationsEnabled: true });
    });
  }, [enable, update]);

  const followedHere = useMemo(
    () => categories.filter((category) => prefs.enabledCategories.includes(category.id)).length,
    [categories, prefs.enabledCategories]
  );

  return (
    <View style={styles.screen}>
      <AppHeader title="Settings" subtitle={label} scrolled={scrolled} />

      <ScrollView
        onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <SectionHeading
          title="Are alerts reaching you?"
          caption="What the server sent, against what this phone actually received."
        />
        <SectionCard>
          <DeliveryHealth
            permission={permission}
            lastSentAt={health?.lastPushSentAt ?? null}
            lastReceivedAt={lastReceivedAt}
            busy={busy}
            onEnable={turnOnAlerts}
            onOpenBatteryGuide={() => setBatteryOpen(true)}
          />
          {error ? (
            <Text maxFontSizeMultiplier={1.4} style={styles.inlineError}>
              {error}
            </Text>
          ) : null}
        </SectionCard>

        {batteryOpen ? (
          <>
            <SectionHeading
              title="Your phone's battery manager"
              caption="A limitation of the phone, not of Bachat."
            />
            <SectionCard>
              <BatteryGuide
                onDone={() => {
                  updateSettings({ batteryGuideDone: true });
                  setBatteryOpen(false);
                }}
              />
            </SectionCard>
          </>
        ) : null}

        <SectionHeading
          title={`${label} categories`}
          caption="These gate the Deals feed and which alerts are allowed through."
        />
        <SectionCard>
          {facets ? (
            <CategoryPicker
              categories={categories}
              enabled={prefs.enabledCategories}
              accent={accent.accent}
              accentWash={accent.wash}
              onToggle={toggleCategory}
              onSelectAll={followAll}
            />
          ) : (
            <Skeleton width="100%" height={64} />
          )}
        </SectionCard>

        <SectionHeading title="When to interrupt you" />
        <SectionCard flush>
          <SettingRow label="Discount threshold">
            <ThresholdControl
              value={prefs.threshold}
              accent={accent.accent}
              onChange={(threshold) => update({ threshold })}
            />
          </SettingRow>
          <View style={styles.rowRule} />
          <SettingRow label="Quiet hours">
            <QuietHoursControl
              value={prefs.quietHours}
              onChange={(quietHours) => update({ quietHours })}
            />
          </SettingRow>
        </SectionCard>

        <SectionHeading
          title="Delivery and handling fees"
          caption="Typed by you, because they change with the cart and are never scraped."
        />
        <SectionCard>
          {facets ? (
            <FeeEditor
              retailers={retailers}
              fees={prefs.fees}
              accent={accent.accent}
              onChange={setFees}
            />
          ) : (
            <Skeleton width="100%" height={120} />
          )}
        </SectionCard>

        <SectionHeading
          title="Where you order"
          caption="Quick-commerce prices differ store by store."
        />
        <SectionCard>
          <LocationCard
            pincode={prefs.pincode}
            lat={prefs.lat}
            lon={prefs.lon}
            accent={accent.accent}
            onChange={update}
          />
        </SectionCard>

        <SectionHeading title="This device" />
        <SectionCard flush>
          <SettingRow
            label="Haptics"
            hint="A small tap on price rows, chips and the mode switch."
            trailing={
              <Switch
                value={settings.haptics}
                onValueChange={(haptics) => updateSettings({ haptics })}
                trackColor={{ false: palette.surfacePressed, true: accent.wash }}
                thumbColor={settings.haptics ? accent.accent : palette.surface}
                accessibilityLabel="Haptics"
              />
            }
          />
          <View style={styles.rowRule} />
          <SettingRow
            label="Run first-time setup again"
            hint="Location, categories, alerts and the battery step, in order."
            trailing={
              <Button label="Start" tone="quiet" size="sm" onPress={() => setSetupOpen(true)} />
            }
          />
          <View style={styles.rowRule} />
          <SettingRow
            label="Reset every setting"
            hint="Puts categories, threshold, quiet hours, fees and location back to their defaults."
            trailing={<Button label="Reset" tone="danger" size="sm" onPress={reset} />}
          />
        </SectionCard>

        <View style={styles.footer}>
          <Text maxFontSizeMultiplier={1.3} style={styles.footerLine}>
            {apiClient.demo
              ? 'Showing demo prices — no price server is configured on this build.'
              : `Prices from ${apiClient.baseUrl}`}
          </Text>
          {health ? (
            <Text maxFontSizeMultiplier={1.3} style={styles.footerLine}>
              {health.products} prices across {health.retailers} retailers
              {health.staleSweep ? ', with at least one sweep overdue' : ''}.
            </Text>
          ) : null}
          {followedHere === 0 ? (
            <Text maxFontSizeMultiplier={1.3} style={styles.footerWarn}>
              No {label.toLowerCase()} categories are followed, so that feed will stay empty.
            </Text>
          ) : null}
          {syncError ? (
            <Text maxFontSizeMultiplier={1.3} style={styles.footerWarn}>
              Settings are saved on this phone but have not reached the server yet.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <Modal
        visible={setupOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setSetupOpen(false)}
      >
        <OnboardingFlow onDone={() => setSetupOpen(false)} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.void,
  },
  content: {
    paddingBottom: spacing.huge,
  },
  rowRule: {
    height: layout.hairline,
    backgroundColor: palette.line,
    marginLeft: spacing.lg,
  },
  inlineError: {
    ...type.caption,
    color: palette.danger,
    marginTop: spacing.md,
  },
  footer: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xxl,
    gap: spacing.xs,
  },
  footerLine: {
    ...type.caption,
    color: palette.textMuted,
  },
  footerWarn: {
    ...type.caption,
    color: palette.stale,
  },
});
