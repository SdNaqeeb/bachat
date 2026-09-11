/**
 * The four tabs (spec §9), in the order the user needs them.
 *
 * Basket is first and is the app's home: it is the screen that answers the
 * question the product exists for. Deals and Compare are the two ways of
 * looking sideways from that answer, and Settings is where it all gets tuned.
 *
 * The active tint is the current mode's accent, so flipping the header switch
 * visibly re-colours the whole chrome rather than only the switch itself.
 * Labels stay on: four icons alone are guessable, four labelled icons are not.
 */

import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { useMode } from '@/hooks/use-mode';
import { layout, palette, type } from '@/theme';

export default function TabsLayout() {
  const { accent } = useMode();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent.accent,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarStyle: {
          height: layout.tabBarHeight,
          backgroundColor: palette.surface,
          borderTopWidth: layout.hairline,
          borderTopColor: palette.line,
        },
        tabBarLabelStyle: type.tag,
        sceneStyle: { backgroundColor: palette.void },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Basket',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="basket-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="deals"
        options={{
          title: 'Deals',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="pricetags-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="compare"
        options={{
          title: 'Compare',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="options-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
