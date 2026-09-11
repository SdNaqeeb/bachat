/**
 * When notifications are held back (spec §7).
 *
 * The important word is *held*, not dropped: a 2 a.m. price drop still reaches
 * the user at 8 a.m. rather than vanishing. That is the one thing this control
 * has to communicate, because "quiet hours" in most apps means "you will never
 * hear about it", and here it does not.
 *
 * Hours are stepped rather than typed or picked from a wheel. The setting is
 * whole hours by definition, it is changed roughly once, and a stepper needs no
 * keyboard and cannot produce an invalid value.
 */

import { StyleSheet, Text, View } from 'react-native';

import { IconButton } from '@/components/ui/button';
import type { QuietHours } from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

/** `23` -> `11 pm`. Indian phones are mixed 12/24h; words are unambiguous. */
function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

export type QuietHoursControlProps = {
  value: QuietHours;
  onChange: (next: QuietHours) => void;
};

export function QuietHoursControl({ value, onChange }: QuietHoursControlProps) {
  const wrap = (hour: number) => (hour + 24) % 24;

  return (
    <View style={styles.root}>
      <View style={styles.pair}>
        <HourStepper
          label="From"
          hour={value.start}
          onChange={(start) => onChange({ ...value, start: wrap(start) })}
        />
        <HourStepper
          label="Until"
          hour={value.end}
          onChange={(end) => onChange({ ...value, end: wrap(end) })}
        />
      </View>

      <Text maxFontSizeMultiplier={1.4} style={styles.note}>
        Alerts between {hourLabel(value.start)} and {hourLabel(value.end)} are held until
        morning, not thrown away.
      </Text>
    </View>
  );
}

type HourStepperProps = {
  label: string;
  hour: number;
  onChange: (next: number) => void;
};

function HourStepper({ label, hour, onChange }: HourStepperProps) {
  return (
    <View style={styles.stepper}>
      <Text maxFontSizeMultiplier={1.3} style={styles.stepperLabel}>
        {label}
      </Text>
      <View style={styles.stepperRow}>
        <IconButton
          icon="chevron-back"
          label={`One hour earlier, ${label.toLowerCase()}`}
          onPress={() => onChange(hour - 1)}
        />
        <Text maxFontSizeMultiplier={1.2} style={styles.hour}>
          {hourLabel(hour)}
        </Text>
        <IconButton
          icon="chevron-forward"
          label={`One hour later, ${label.toLowerCase()}`}
          onPress={() => onChange(hour + 1)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
  },
  pair: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  stepper: {
    flex: 1,
    gap: spacing.xs,
  },
  stepperLabel: {
    ...type.caption,
    color: palette.textSecondary,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.md,
    borderWidth: layout.hairline,
    borderColor: palette.line,
    backgroundColor: palette.surfaceRaised,
    paddingHorizontal: spacing.xxs,
  },
  hour: {
    ...type.priceSmall,
    color: palette.textPrimary,
  },
  note: {
    ...type.caption,
    color: palette.textSecondary,
  },
});
