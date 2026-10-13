export class CppMemoryWriter {
    baseOffset;
    constructor(buffer, baseOffset = 0) {
        this.baseOffset = baseOffset;
        this.view = new DataView(buffer);
    }
    view;
    setBaseOffset(offset) {
        this.baseOffset = offset;
    }
    writeInt(offset, value) {
        this.view.setInt32(this.baseOffset + offset, value, true);
    }
    writeString(offset, value, lengthWithNullTerminator) {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(value);
        const bytes = new Uint8Array(this.view.buffer, this.baseOffset + offset, lengthWithNullTerminator);
        for (let i = 0; i < lengthWithNullTerminator - 1; i++) {
            // biome-ignore lint/style/noNonNullAssertion: index arithmetic
            bytes[i] = i < encoded.length ? encoded[i] : 0;
        }
        bytes[lengthWithNullTerminator - 1] = 0; // null-terminate the string
    }
    writeDouble(offset, value) {
        this.view.setFloat64(this.baseOffset + offset, value, true);
    }
    writeChar(offset, value) {
        const charCode = value.charCodeAt(0) || 0;
        this.view.setInt8(this.baseOffset + offset, charCode);
    }
    writeBoolean(offset, value) {
        this.view.setInt8(this.baseOffset + offset, value ? 1 : 0);
    }
    writeValue(fieldName, offset, type, value, size) {
        switch (type) {
            case 'bool': {
                // todo test performance without these checks
                if (typeof value !== 'boolean') {
                    throw new Error(`Expected boolean for ${fieldName}, got ${typeof value}`);
                }
                this.writeBoolean(offset, value);
                break;
            }
            case 'double': {
                if (typeof value !== 'number') {
                    throw new Error(`Expected number for ${fieldName}, got ${typeof value}`);
                }
                this.writeDouble(offset, value);
                break;
            }
            case 'int': {
                if (typeof value !== 'number') {
                    throw new Error(`Expected number for ${fieldName}, got ${typeof value}`);
                }
                this.writeInt(offset, value);
                break;
            }
            case 'char': {
                if (typeof value !== 'string') {
                    throw new Error(`Expected char for ${fieldName}, got "${typeof value}"`);
                }
                this.writeChar(offset, value);
                break;
            }
            case 'char[]': {
                if (typeof value !== 'string') {
                    throw new Error(`Expected string for ${fieldName}, got "${typeof value}"`);
                }
                this.writeString(offset, value, size);
                break;
            }
            default: {
                throw new Error(`Writing type ${type} not implemented (field ${fieldName})`);
            }
        }
    }
}
