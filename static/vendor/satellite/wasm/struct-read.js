export class CppMemoryReader {
    baseOffset;
    constructor(buffer, baseOffset = 0) {
        this.baseOffset = baseOffset;
        this.view = new DataView(buffer);
    }
    view;
    readInt(offset) {
        const value = this.view.getInt32(this.baseOffset + offset, true);
        return value;
    }
    readLong(offset) {
        // Assuming 'long' is 32-bit in this context
        return this.readInt(offset);
    }
    readString(offset, length) {
        const bytes = new Uint8Array(this.view.buffer, this.baseOffset + offset, length);
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    readDouble(offset) {
        const value = this.view.getFloat64(this.baseOffset + offset, true);
        return value;
    }
    readUnsignedChar(offset) {
        const value = this.view.getUint8(this.baseOffset + offset);
        return value;
    }
    readChar(offset) {
        const value = this.view.getInt8(this.baseOffset + offset);
        return String.fromCharCode(value);
    }
}
