"""Nexus live link — send the selection from Blender to the running editor.

Install: Blender > Edit > Preferences > Add-ons > Install..., pick this
file, tick "Nexus live link". The panel appears in the 3D viewport's
sidebar (N) under "Nexus".

What it does: exports the current selection to glTF binary and POSTs it
to the editor's dev host, which writes it to `<repo>/assets/live/<name>.glb`
and shows it in the editor's Blender panel. `assets/` is gitignored, so
nothing sent this way can be committed by accident.

It uses only Blender's own Python and the standard library: no pip, no
wheel, nothing to keep in step with the engine.
"""

bl_info = {
    "name": "Nexus live link",
    "author": "Nexus engine",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Nexus",
    "description": "Send the selection to the running Nexus editor as glTF",
    "category": "Import-Export",
}

import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

import bpy
from bpy.app.handlers import persistent

NAME_OK = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
TIMEOUT_S = 30


def _settings(context):
    return context.scene.nexus_live_link


def _default_name():
    """The .blend file's stem, lower-cased into the host's name rule."""
    stem = os.path.splitext(os.path.basename(bpy.data.filepath))[0] or "untitled"
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", stem.lower()).strip("-_")
    return cleaned[:64] or "untitled"


def _export_selection(path):
    """Selection to .glb. Raises RuntimeError when Blender refuses."""
    result = bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
    )
    if "FINISHED" not in result:
        raise RuntimeError("Blender's glTF exporter did not finish")


def _push(host, name, path):
    """POST the file. Returns the host's message, or raises RuntimeError."""
    query = urllib.parse.urlencode(
        {"name": name, "from": os.path.basename(bpy.data.filepath) or "unsaved.blend"}
    )
    url = "%s/api/editor/blender/push?%s" % (host.rstrip("/"), query)
    with open(path, "rb") as handle:
        data = handle.read()
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "model/gltf-binary", "Content-Length": str(len(data))},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S):
            return "sent %s (%.1f KB)" % (name, len(data) / 1024.0)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf8", "replace")[:300]
        raise RuntimeError("editor refused the push: %s %s" % (err.code, detail))
    except urllib.error.URLError as err:
        raise RuntimeError(
            "no editor at %s (%s). Start it with: npm run dev --workspace apps/editor"
            % (host, err.reason)
        )


def send(context):
    settings = _settings(context)
    name = (settings.model_name or _default_name()).strip().lower()
    if not NAME_OK.match(name):
        raise RuntimeError(
            "model name must be lower-case letters, digits, - and _ (max 64): %r" % name
        )
    if not context.selected_objects:
        raise RuntimeError("nothing selected — select the objects to send")

    handle, path = tempfile.mkstemp(suffix=".glb")
    os.close(handle)
    try:
        _export_selection(path)
        return _push(settings.host, name, path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class NexusLiveLinkSettings(bpy.types.PropertyGroup):
    host: bpy.props.StringProperty(
        name="Editor",
        description="Where the editor's dev server is listening",
        default="http://localhost:5174",
    )
    model_name: bpy.props.StringProperty(
        name="Model name",
        description="Name in the editor; empty uses the .blend file's name",
        default="",
    )
    on_save: bpy.props.BoolProperty(
        name="Send on save",
        description="Send the selection every time this .blend is saved",
        default=False,
    )


class NEXUS_OT_send_selection(bpy.types.Operator):
    bl_idname = "nexus.send_selection"
    bl_label = "Send selection"
    bl_description = "Export the selection to glTF and send it to the running editor"

    def execute(self, context):
        try:
            self.report({"INFO"}, "Nexus: " + send(context))
            return {"FINISHED"}
        except Exception as err:  # noqa: BLE001 - every failure is reported to the user
            self.report({"ERROR"}, "Nexus: %s" % err)
            return {"CANCELLED"}


class NEXUS_PT_panel(bpy.types.Panel):
    bl_label = "Nexus live link"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Nexus"

    def draw(self, context):
        settings = _settings(context)
        layout = self.layout
        layout.prop(settings, "host")
        layout.prop(settings, "model_name")
        if not settings.model_name:
            layout.label(text="Name: %s (from the .blend)" % _default_name())
        layout.prop(settings, "on_save")
        row = layout.row()
        row.enabled = bool(context.selected_objects)
        row.operator(NEXUS_OT_send_selection.bl_idname, icon="EXPORT")
        if not context.selected_objects:
            layout.label(text="Select what to send", icon="INFO")


@persistent
def _on_save(_dummy):
    context = bpy.context
    try:
        settings = _settings(context)
    except AttributeError:
        return
    if not settings.on_save or not context.selected_objects:
        return
    try:
        send(context)
    except Exception as err:  # noqa: BLE001 - a failed auto-send must not block the save
        print("Nexus live link: %s" % err)


CLASSES = (NexusLiveLinkSettings, NEXUS_OT_send_selection, NEXUS_PT_panel)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.nexus_live_link = bpy.props.PointerProperty(type=NexusLiveLinkSettings)
    if _on_save not in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.append(_on_save)


def unregister():
    if _on_save in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.remove(_on_save)
    del bpy.types.Scene.nexus_live_link
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
