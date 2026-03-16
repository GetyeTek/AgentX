import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

serve(async (req) => {
  const { apps } = await req.json();
  
  // Clear old list and upsert new list
  // Using upsert on package_name to avoid duplicates
  const { error } = await supabase
    .from('installed_apps')
    .upsert(apps, { onConflict: 'package_name' });

  if (error) return new Response(error.message, { status: 500 });
  return new Response("Synced", { status: 200 });
});