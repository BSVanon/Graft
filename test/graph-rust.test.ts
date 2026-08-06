/**
 * Tests for Rust extraction in the Tier-1 code graph. Builds a small Rust crate in a
 * temp dir and asserts the emitted nodes (free fns, impl methods, structs, unions,
 * enums, traits, type aliases) and edges (calls, `use` imports) match the AST walk in
 * extract.ts.
 *
 * Rust support is a fork patch (tree-sitter-rust) that upstream doesn't carry, so this
 * file is its regression guard: an upstream sync that changes the extractor and drops
 * Rust — or an accidental revert of the grammar wiring — turns this suite red instead
 * of silently un-indexing every `.rs` repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

// Exercises every extracted shape: `pub`/private free fns, a struct + impl block with
// pub/private methods and an associated fn, a union (→ struct), an enum, a trait
// (→ interface), a type alias, plain calls, a member call (`self.name_len()`), a
// scoped call (`User::make()`), and two `use` forms. The member/scoped calls are here
// to drive the field_expression / scoped_identifier callee branches without crashing —
// they don't resolve to edges (no self→impl-type map, mirroring Go's receiver limits).
const LIB_RS = `use std::fmt;
use crate::util::helper;

pub type ID = u32;

pub struct User {
    pub name: String,
}

pub union Value {
    int: i32,
    float: f32,
}

pub enum Color {
    Red,
    Green,
}

pub trait Reader {
    fn read(&self) -> Result<(), ()>;
}

pub fn foo() {
    helper();
    bar();
}

fn bar() {}

impl User {
    pub fn save(&self) -> Result<(), ()> {
        foo();
        self.name_len();
        Ok(())
    }

    fn name_len(&self) -> usize {
        self.name.len()
    }

    pub fn make() -> User {
        User { name: String::new() }
    }
}

pub fn caller() {
    let _ = User::make();
}
`;

const UTIL_RS = `pub fn helper() {}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-"));
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "probe"\nversion = "0.1.0"\n');
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), LIB_RS);
  writeFileSync(join(dir, "src", "util.rs"), UTIL_RS);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Rust extraction: free fns, impl methods, structs, unions, enums, traits, type aliases", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("rust"), "languages should include rust");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    // free functions — exported by a `pub` visibility modifier, not by name casing
    const foo = nodeById(graph!, "src/lib.rs#foo");
    assert.equal(foo?.kind, "function");
    assert.equal(foo?.exported, true);
    assert.equal(nodeById(graph!, "src/lib.rs#bar")?.exported, false);

    // impl methods — id qualified by the impl type (`User.save`), pub drives exported
    const save = nodeById(graph!, "src/lib.rs#User.save");
    assert.equal(save?.kind, "method");
    assert.equal(save?.exported, true);
    const nameLen = nodeById(graph!, "src/lib.rs#User.name_len");
    assert.equal(nameLen?.kind, "method");
    assert.equal(nameLen?.exported, false);
    // an associated fn (no `self`) is still a method under its impl type
    assert.equal(nodeById(graph!, "src/lib.rs#User.make")?.kind, "method");

    // named types — struct, union (→ struct), enum, trait (→ interface), type alias
    assert.equal(nodeById(graph!, "src/lib.rs#User")?.kind, "struct");
    assert.equal(nodeById(graph!, "src/lib.rs#Value")?.kind, "struct");
    assert.equal(nodeById(graph!, "src/lib.rs#Color")?.kind, "enum");
    assert.equal(nodeById(graph!, "src/lib.rs#Reader")?.kind, "interface");
    assert.equal(nodeById(graph!, "src/lib.rs#ID")?.kind, "type");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust extraction: call and use-import edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // same-file plain call resolves: foo() → bar()
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "src/lib.rs#foo" && e.target === "src/lib.rs#bar",
      ),
      "foo should have a resolved calls edge to bar",
    );

    // cross-file plain call resolves by bare name: foo() → util.rs helper()
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "src/lib.rs#foo" && e.target === "src/util.rs#helper",
      ),
      "foo should resolve helper() to src/util.rs#helper",
    );

    // a plain call made from inside an impl method resolves: User.save() → foo()
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "src/lib.rs#User.save" && e.target === "src/lib.rs#foo",
      ),
      "User.save should have a resolved calls edge to foo",
    );

    // `use` declarations become coarse import edges keyed by the full use path
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "imports" && e.source === "src/lib.rs" && e.target === "std::fmt",
      ),
      "use std::fmt should produce an import edge",
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "imports" && e.source === "src/lib.rs" && e.target === "crate::util::helper",
      ),
      "use crate::util::helper should produce an import edge",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
