package com.dshremote.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CloudRelayLayoutTest {
  @Test
  public void webContentStartsBelowToolbarAndSystemInsets() {
    try (ActivityScenario<CloudRelayActivity> scenario = ActivityScenario.launch(CloudRelayActivity.class)) {
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      scenario.onActivity(activity -> {
        View root = activity.findViewById(R.id.cloud_relay_root);
        View toolbar = activity.findViewById(R.id.cloud_relay_toolbar);
        View content = activity.findViewById(R.id.cloud_relay_content);
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(root);
        assertNotNull(insets);
        int safeTop = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()).top;
        int[] rootPosition = new int[2];
        int[] toolbarPosition = new int[2];
        int[] contentPosition = new int[2];
        root.getLocationInWindow(rootPosition);
        toolbar.getLocationInWindow(toolbarPosition);
        content.getLocationInWindow(contentPosition);
        assertTrue(toolbar.getHeight() > 0);
        assertTrue(content.getHeight() > 0);
        assertEquals(safeTop, toolbarPosition[1] - rootPosition[1]);
        assertEquals(toolbarPosition[1] + toolbar.getHeight(), contentPosition[1]);
      });
    }
  }
}
