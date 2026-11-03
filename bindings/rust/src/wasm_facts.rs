//! Read bounded Wasm declaration facts without validating executable code.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use wasmparser::BinaryReader;

pub const WASM_FACTS_MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const WASM_FACTS_MAX_VECTOR_ELEMENTS: usize = 50_000;
pub const WASM_FACTS_MAX_NAME_BYTES: usize = 4 * 1024 * 1024;
pub const WASM_FACTS_MAX_SECTIONS: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasmCheck {
    NotRun,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WasmValueType {
    I32,
    I64,
    F32,
    F64,
    V128,
    FuncRef,
    ExternRef,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasmReferenceType {
    FuncRef,
    ExternRef,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmFunctionType {
    pub params: Vec<WasmValueType>,
    pub results: Vec<WasmValueType>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WasmTableType {
    pub element: WasmReferenceType,
    pub minimum: u32,
    pub maximum: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WasmMemoryType {
    pub minimum_pages: u32,
    pub maximum_pages: Option<u32>,
    pub shared: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WasmGlobalType {
    pub value: WasmValueType,
    pub mutable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasmExternal {
    Function { index: u32, type_index: u32 },
    Table { index: u32, ty: WasmTableType },
    Memory { index: u32, ty: WasmMemoryType },
    Global { index: u32, ty: WasmGlobalType },
    Tag { index: u32, type_index: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmImportFact {
    pub module: String,
    pub name: String,
    pub external: WasmExternal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmExportFact {
    pub name: String,
    pub external: WasmExternal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmIndexed<T> {
    pub index: u32,
    pub imported: bool,
    pub ty: T,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WasmIndexedFunction {
    pub index: u32,
    pub imported: bool,
    pub type_index: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WasmStart {
    pub index: u32,
    pub type_index: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmFacts {
    pub sha256: String,
    pub types: Vec<WasmFunctionType>,
    pub imports: Vec<WasmImportFact>,
    pub exports: Vec<WasmExportFact>,
    pub functions: Vec<WasmIndexedFunction>,
    pub tables: Vec<WasmIndexed<WasmTableType>>,
    pub memories: Vec<WasmIndexed<WasmMemoryType>>,
    pub globals: Vec<WasmIndexed<WasmGlobalType>>,
    pub tags: Vec<WasmIndexedFunction>,
    pub start: Option<WasmStart>,
    pub validation: WasmCheck,
    pub feature_detection: WasmCheck,
    pub abi_detection: WasmCheck,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmFactsError(String);
impl fmt::Display for WasmFactsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WasmFactsError {}
impl From<wasmparser::BinaryReaderError> for WasmFactsError {
    fn from(value: wasmparser::BinaryReaderError) -> Self {
        Self(value.to_string())
    }
}
fn error(message: &str) -> WasmFactsError {
    WasmFactsError(message.to_owned())
}
type Result<T> = std::result::Result<T, WasmFactsError>;

#[derive(Default)]
struct Budget {
    elements: usize,
    names: usize,
}

fn reserve<T>(items: &mut Vec<T>, count: usize) -> Result<()> {
    items
        .try_reserve(count)
        .map_err(|_| error("Wasm facts allocation failed"))
}

fn vector(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<usize> {
    let count = reader.read_var_u32()? as usize;
    if count > reader.bytes_remaining() {
        return Err(error("truncated Wasm vector"));
    }
    budget.elements = budget
        .elements
        .checked_add(count)
        .filter(|n| *n <= WASM_FACTS_MAX_VECTOR_ELEMENTS)
        .ok_or_else(|| error("Wasm facts inspection limit: vector elements"))?;
    Ok(count)
}

fn name(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<String> {
    let count = reader.read_var_u32()? as usize;
    if count > reader.bytes_remaining() {
        return Err(error("truncated Wasm name"));
    }
    budget.names = budget
        .names
        .checked_add(count)
        .filter(|n| *n <= WASM_FACTS_MAX_NAME_BYTES)
        .ok_or_else(|| error("Wasm facts inspection limit: name bytes"))?;
    let bytes = reader.read_bytes(count)?;
    let text = std::str::from_utf8(bytes).map_err(|_| error("invalid Wasm UTF-8 name"))?;
    let mut result = String::new();
    result
        .try_reserve_exact(count)
        .map_err(|_| error("Wasm facts allocation failed"))?;
    result.push_str(text);
    Ok(result)
}

fn value(reader: &mut BinaryReader<'_>) -> Result<WasmValueType> {
    Ok(match reader.read_u8()? {
        0x7f => WasmValueType::I32,
        0x7e => WasmValueType::I64,
        0x7d => WasmValueType::F32,
        0x7c => WasmValueType::F64,
        0x7b => WasmValueType::V128,
        0x70 => WasmValueType::FuncRef,
        0x6f => WasmValueType::ExternRef,
        _ => return Err(error("unsupported Wasm value type")),
    })
}
fn reference(reader: &mut BinaryReader<'_>) -> Result<WasmReferenceType> {
    match value(reader)? {
        WasmValueType::FuncRef => Ok(WasmReferenceType::FuncRef),
        WasmValueType::ExternRef => Ok(WasmReferenceType::ExternRef),
        _ => Err(error("unsupported Wasm reference type")),
    }
}
fn values(reader: &mut BinaryReader<'_>, budget: &mut Budget) -> Result<Vec<WasmValueType>> {
    let count = vector(reader, budget)?;
    let mut result = Vec::new();
    reserve(&mut result, count)?;
    for _ in 0..count {
        result.push(value(reader)?);
    }
    Ok(result)
}
fn table(reader: &mut BinaryReader<'_>) -> Result<WasmTableType> {
    let element = reference(reader)?;
    let flags = reader.read_u8()?;
    if flags > 1 {
        return Err(error("unsupported table limits flags"));
    }
    let minimum = reader.read_var_u32()?;
    let maximum = if flags == 1 {
        Some(reader.read_var_u32()?)
    } else {
        None
    };
    if maximum.is_some_and(|max| max < minimum) {
        return Err(error("table maximum is smaller than minimum"));
    }
    Ok(WasmTableType {
        element,
        minimum,
        maximum,
    })
}
fn memory(reader: &mut BinaryReader<'_>) -> Result<WasmMemoryType> {
    let flags = reader.read_u8()?;
    if !matches!(flags, 0 | 1 | 3) {
        return Err(error("unsupported memory limits flags"));
    }
    let minimum_pages = reader.read_var_u32()?;
    let maximum_pages = if flags & 1 != 0 {
        Some(reader.read_var_u32()?)
    } else {
        None
    };
    if minimum_pages > 65536 || maximum_pages.is_some_and(|max| max > 65536 || max < minimum_pages)
    {
        return Err(error("invalid wasm32 memory limits"));
    }
    Ok(WasmMemoryType {
        minimum_pages,
        maximum_pages,
        shared: flags & 2 != 0,
    })
}
fn global(reader: &mut BinaryReader<'_>) -> Result<WasmGlobalType> {
    let value = value(reader)?;
    let mutable = match reader.read_u8()? {
        0 => false,
        1 => true,
        _ => return Err(error("invalid global mutability")),
    };
    Ok(WasmGlobalType { value, mutable })
}
fn initializer(reader: &mut BinaryReader<'_>) -> Result<()> {
    match reader.read_u8()? {
        0x41 => {
            reader.read_var_i32()?;
        }
        0x42 => {
            reader.read_var_i64()?;
        }
        0x43 => {
            reader.read_bytes(4)?;
        }
        0x44 => {
            reader.read_bytes(8)?;
        }
        0x23 | 0xd2 => {
            reader.read_var_u32()?;
        }
        0xd0 => {
            reference(reader)?;
        }
        _ => return Err(error("unsupported global initializer opcode")),
    }
    if reader.read_u8()? != 0x0b {
        return Err(error("unsupported global initializer expression"));
    }
    Ok(())
}
fn at<T>(items: &[T], index: u32) -> Result<&T> {
    items
        .get(index as usize)
        .ok_or_else(|| error("Wasm index out of bounds"))
}
fn tag(reader: &mut BinaryReader<'_>, types: &[WasmFunctionType]) -> Result<u32> {
    if reader.read_u8()? != 0 {
        return Err(error("unsupported tag attribute"));
    }
    let index = reader.read_var_u32()?;
    if !at(types, index)?.results.is_empty() {
        return Err(error("tag type must not have results"));
    }
    Ok(index)
}

/// Read declarations from a private, bounded snapshot. Code, element and data payloads are not validated; this does not establish feature, ABI, or runtime safety.
pub fn inspect_wasm_facts(bytes: &[u8]) -> Result<WasmFacts> {
    if bytes.len() > WASM_FACTS_MAX_INPUT_BYTES {
        return Err(error("Wasm facts inspection limit: input bytes"));
    }
    let mut snapshot = Vec::new();
    reserve(&mut snapshot, bytes.len())?;
    snapshot.extend_from_slice(bytes);
    inspect_wasm_snapshot(&snapshot)
}

pub(crate) fn inspect_wasm_snapshot(bytes: &[u8]) -> Result<WasmFacts> {
    if bytes.len() > WASM_FACTS_MAX_INPUT_BYTES {
        return Err(error("Wasm facts inspection limit: input bytes"));
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let mut root = BinaryReader::new(bytes, 0);
    if root.read_bytes(8)? != b"\0asm\x01\0\0\0" {
        return Err(error("expected a core Wasm version 1 module"));
    }
    let mut budget = Budget::default();
    let mut types = Vec::new();
    let mut functions = Vec::new();
    let mut tables = Vec::new();
    let mut memories = Vec::new();
    let mut globals = Vec::new();
    let mut tags = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut export_names = HashSet::new();
    let mut imported = [0usize; 5];
    let mut start = None;
    let mut previous = 0;
    let mut sections = 0usize;
    while !root.eof() {
        sections += 1;
        if sections > WASM_FACTS_MAX_SECTIONS {
            return Err(error("Wasm facts inspection limit: sections"));
        }
        let id = root.read_u8()?;
        let length = root.read_var_u32()? as usize;
        let mut reader = BinaryReader::new(root.read_bytes(length)?, 0);
        if id == 0 {
            name(&mut reader, &mut budget)?;
            continue;
        }
        let order = match id {
            1..=5 => id,
            13 => 6,
            6 => 7,
            7 => 8,
            8 => 9,
            9 => 10,
            12 => 11,
            10 => 12,
            11 => 13,
            _ => return Err(error("unsupported Wasm section")),
        };
        if order <= previous {
            return Err(error("duplicate or out-of-order Wasm section"));
        }
        previous = order;
        match id {
            1 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut types, count)?;
                for _ in 0..count {
                    if reader.read_u8()? != 0x60 {
                        return Err(error("unsupported type definition"));
                    }
                    types.push(WasmFunctionType {
                        params: values(&mut reader, &mut budget)?,
                        results: values(&mut reader, &mut budget)?,
                    });
                }
            }
            2 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut imports, count)?;
                for _ in 0..count {
                    let module = name(&mut reader, &mut budget)?;
                    let name = name(&mut reader, &mut budget)?;
                    let kind = reader.read_u8()?;
                    let external = match kind {
                        0 => {
                            let type_index = reader.read_var_u32()?;
                            at(&types, type_index)?;
                            reserve(&mut functions, 1)?;
                            let index = functions.len() as u32;
                            functions.push(type_index);
                            WasmExternal::Function { index, type_index }
                        }
                        1 => {
                            let ty = table(&mut reader)?;
                            reserve(&mut tables, 1)?;
                            let index = tables.len() as u32;
                            tables.push(ty);
                            WasmExternal::Table { index, ty }
                        }
                        2 => {
                            let ty = memory(&mut reader)?;
                            reserve(&mut memories, 1)?;
                            let index = memories.len() as u32;
                            memories.push(ty);
                            WasmExternal::Memory { index, ty }
                        }
                        3 => {
                            let ty = global(&mut reader)?;
                            reserve(&mut globals, 1)?;
                            let index = globals.len() as u32;
                            globals.push(ty);
                            WasmExternal::Global { index, ty }
                        }
                        4 => {
                            let type_index = tag(&mut reader, &types)?;
                            reserve(&mut tags, 1)?;
                            let index = tags.len() as u32;
                            tags.push(type_index);
                            WasmExternal::Tag { index, type_index }
                        }
                        _ => return Err(error("unsupported import kind")),
                    };
                    imported[kind as usize] += 1;
                    imports.push(WasmImportFact {
                        module,
                        name,
                        external,
                    });
                }
            }
            3 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut functions, count)?;
                for _ in 0..count {
                    let index = reader.read_var_u32()?;
                    at(&types, index)?;
                    functions.push(index);
                }
            }
            4 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut tables, count)?;
                for _ in 0..count {
                    tables.push(table(&mut reader)?);
                }
            }
            5 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut memories, count)?;
                for _ in 0..count {
                    memories.push(memory(&mut reader)?);
                }
            }
            13 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut tags, count)?;
                for _ in 0..count {
                    tags.push(tag(&mut reader, &types)?);
                }
            }
            6 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut globals, count)?;
                for _ in 0..count {
                    let ty = global(&mut reader)?;
                    initializer(&mut reader)?;
                    globals.push(ty);
                }
            }
            7 => {
                let count = vector(&mut reader, &mut budget)?;
                reserve(&mut exports, count)?;
                export_names
                    .try_reserve(count)
                    .map_err(|_| error("Wasm facts allocation failed"))?;
                for _ in 0..count {
                    let name = name(&mut reader, &mut budget)?;
                    let mut export_name = String::new();
                    export_name
                        .try_reserve_exact(name.len())
                        .map_err(|_| error("Wasm facts allocation failed"))?;
                    export_name.push_str(&name);
                    if !export_names.insert(export_name) {
                        return Err(error("duplicate Wasm export"));
                    }
                    let kind = reader.read_u8()?;
                    let index = reader.read_var_u32()?;
                    let external = match kind {
                        0 => WasmExternal::Function {
                            index,
                            type_index: *at(&functions, index)?,
                        },
                        1 => WasmExternal::Table {
                            index,
                            ty: *at(&tables, index)?,
                        },
                        2 => WasmExternal::Memory {
                            index,
                            ty: *at(&memories, index)?,
                        },
                        3 => WasmExternal::Global {
                            index,
                            ty: *at(&globals, index)?,
                        },
                        4 => WasmExternal::Tag {
                            index,
                            type_index: *at(&tags, index)?,
                        },
                        _ => return Err(error("unsupported export kind")),
                    };
                    exports.push(WasmExportFact { name, external });
                }
            }
            8 => {
                let index = reader.read_var_u32()?;
                let type_index = *at(&functions, index)?;
                let ty = at(&types, type_index)?;
                if !ty.params.is_empty() || !ty.results.is_empty() {
                    return Err(error("start function must have no parameters or results"));
                }
                start = Some(WasmStart { index, type_index });
            }
            12 => {
                reader.read_var_u32()?;
            }
            9..=11 => continue,
            _ => unreachable!(),
        }
        if !reader.eof() {
            return Err(error("trailing bytes in Wasm section"));
        }
    }
    fn indexed<T>(items: Vec<T>, imported: usize) -> Result<Vec<WasmIndexed<T>>> {
        let mut result = Vec::new();
        reserve(&mut result, items.len())?;
        result.extend(
            items
                .into_iter()
                .enumerate()
                .map(|(index, ty)| WasmIndexed {
                    index: index as u32,
                    imported: index < imported,
                    ty,
                }),
        );
        Ok(result)
    }
    fn indexed_functions(items: Vec<u32>, imported: usize) -> Result<Vec<WasmIndexedFunction>> {
        let mut result = Vec::new();
        reserve(&mut result, items.len())?;
        result.extend(items.into_iter().enumerate().map(|(index, type_index)| {
            WasmIndexedFunction {
                index: index as u32,
                imported: index < imported,
                type_index,
            }
        }));
        Ok(result)
    }
    Ok(WasmFacts {
        sha256: hash,
        types,
        imports,
        exports,
        functions: indexed_functions(functions, imported[0])?,
        tables: indexed(tables, imported[1])?,
        memories: indexed(memories, imported[2])?,
        globals: indexed(globals, imported[3])?,
        tags: indexed_functions(tags, imported[4])?,
        start,
        validation: WasmCheck::NotRun,
        feature_detection: WasmCheck::NotRun,
        abi_detection: WasmCheck::NotRun,
    })
}
