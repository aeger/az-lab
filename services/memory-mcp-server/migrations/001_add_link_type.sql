-- Migration 001: Add link_type column to memory_links
-- MAGMA-style typed Zettelkasten links
-- Run this in the Supabase SQL editor if the server startup migration fails.
--
-- Apply via: Supabase Dashboard -> SQL Editor -> paste and run

ALTER TABLE memory_links
ADD COLUMN IF NOT EXISTS link_type text NOT NULL DEFAULT 'semantic'
CHECK (link_type IN ('semantic', 'temporal', 'causal', 'entity'));

-- Update existing rows (all existing auto-links are semantic)
UPDATE memory_links SET link_type = 'semantic' WHERE link_type IS NULL;

-- Create the helper function for running startup migrations (used by server bootstrap)
CREATE OR REPLACE FUNCTION public.add_link_type_if_missing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_links' AND column_name = 'link_type'
  ) THEN
    ALTER TABLE memory_links
    ADD COLUMN link_type text NOT NULL DEFAULT 'semantic'
    CHECK (link_type IN ('semantic', 'temporal', 'causal', 'entity'));
    RETURN 'column added';
  ELSE
    RETURN 'column already exists';
  END IF;
END;
$$;

-- Grant execution to service_role
GRANT EXECUTE ON FUNCTION public.add_link_type_if_missing() TO service_role;
