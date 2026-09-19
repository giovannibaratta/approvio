import {MAX_USAGE_QUANTITY} from "@domain"

/** Lua numbers cannot represent the full PostgreSQL bigint range. Keep quantities as decimal strings. */

// TODO: Do we have better stragies to support bigint than doing string math ? Another AI was suggesting to use INCRBY
// TODO: can we have dedicated tests for this ?
export const USAGE_QUANTITY_LUA = `
-- Redis Lua uses floating-point numbers, which cannot exactly represent
-- every PostgreSQL BIGINT value (signed 64-bit integers).
--
-- Quantities are therefore represented as canonical decimal strings.
-- Comparisons, additions, and subtractions operate directly on those
-- strings without converting entire values into Lua numbers.
--
-- Preconditions:
--   - Operands are non-negative decimal integers without leading zeros.
--   - subtract(left, right) requires left >= right.
--   - Results must be checked against maximum before persistence.

-- Maximum permitted quantity, injected by TypeScript.
--
-- It is deliberately stored as a string because Lua numbers
-- cannot safely represent every PostgreSQL BIGINT value.
local maximum = '${MAX_USAGE_QUANTITY}'


-- Compare two non-negative integers represented as decimal strings.
--
-- Returns:
--   -1 if left < right
--    0 if left == right
--    1 if left > right
--
-- IMPORTANT:
-- Both strings must use canonical decimal notation:
--   "0", "1", "123", etc.
-- No negative signs, leading zeros, or decimal points.
local function compare(left, right)

  -- # returns the length of a string.
  --
  -- For canonical non-negative integers, the number with
  -- more digits is always larger.
  --
  -- Example:
  --   "999" < "1000" because 3 < 4 digits.
  if #left ~= #right then
    return #left < #right and -1 or 1
  end

  -- Same number of digits and identical content:
  -- the two numbers are equal.
  if left == right then
    return 0
  end

  -- Both strings have the same length.
  --
  -- Lua compares strings lexicographically.
  -- For equal-length strings containing ASCII decimal digits,
  -- lexicographic ordering equals numeric ordering.
  --
  -- Example:
  --   "123" < "124"
  --   "912" > "899"
  return left < right and -1 or 1

end


-- Validate that a value represents an allowed usage quantity.
--
-- Accepted:
--   "0"
--   "123"
--   "9223372036854775807" (if maximum permits)
--
-- Rejected:
--   "-1"
--   "01"
--   "1.5"
--   "abc"
--   Numbers (rather than strings)
--   Values exceeding maximum
local function is_quantity(value)

  -- Check that value is actually a Lua string.
  return type(value) == 'string'

    -- Reject strings longer than the maximum.
    --
    -- This is an inexpensive preliminary check.
    -- It also rejects excessively long inputs.
    and #value <= #maximum

    -- Validate the decimal representation.
    and (
      -- Zero is allowed as a special case.
      value == '0'

      -- Otherwise:
      -- ^       beginning of string
      -- [1-9]   first digit must be between 1 and 9
      -- [0-9]*  followed by zero or more decimal digits
      -- $       end of string
      --
      -- This prevents leading zeros such as "00123".
      or string.match(value, '^[1-9][0-9]*$') ~= nil
    )

    -- Finally, check the numerical upper bound.
    --
    -- Since the representation is validated,
    -- our string-based comparison is safe.
    and compare(value, maximum) <= 0

end


-- Add two non-negative integers represented as decimal strings.
--
-- This is ordinary column-by-column addition,
-- starting from the rightmost digit.
--
-- Example:
--
--       999
--     +   2
--     -----
--      1001
--
-- No complete input number is ever converted to a Lua number.
local function add(left, right)

  -- Initialize:
  --
  -- i     = position of the last digit in left
  -- j     = position of the last digit in right
  -- carry = carry from the previous addition
  --
  -- Lua strings are indexed starting at 1.
  local i, j, carry = #left, #right, 0

  -- Temporary array containing the output digits.
  --
  -- Digits are initially stored in reverse order.
  local digits = {}

  -- Continue while:
  --   - left has digits remaining, OR
  --   - right has digits remaining, OR
  --   - a carry remains.
  while i > 0 or j > 0 or carry > 0 do

    -- Extract the current digit from left.
    --
    -- string.byte(left, i) returns its ASCII code.
    --
    -- ASCII codes:
    --   '0' = 48
    --   '1' = 49
    --   ...
    --   '9' = 57
    --
    -- Subtracting 48 converts the character to its digit value.
    --
    -- If no digits remain, use zero.
    local a = i > 0 and string.byte(left, i) - 48 or 0

    -- Same operation for the right operand.
    local b = j > 0 and string.byte(right, j) - 48 or 0

    -- Add the current digits and any previous carry.
    --
    -- Maximum possible value:
    --   9 + 9 + 1 = 19
    --
    -- This arithmetic is always exact in Lua.
    local sum = a + b + carry

    -- Extract the last decimal digit using modulo 10.
    --
    -- Example:
    --   19 % 10 = 9
    --
    -- Adding 48 converts it back to an ASCII code.
    -- string.char(...) converts that code to a character.
    --
    -- Append the digit to our temporary array.
    table.insert(digits, string.char(48 + sum % 10))

    -- Compute the carry for the next iteration.
    --
    -- Examples:
    --   floor(19 / 10) = 1
    --   floor( 8 / 10) = 0
    carry = math.floor(sum / 10)

    -- Move one position to the left in both strings.
    i, j = i - 1, j - 1

  end

  -- Digits were generated from right to left.
  --
  -- Example:
  --   digits = {"1", "0", "0", "1"}
  --
  -- table.concat joins them:
  --   "1001"
  --
  -- string.reverse restores the correct order.
  return string.reverse(table.concat(digits))

end


-- Subtract two non-negative integers represented as strings.
--
-- PRECONDITION:
--   left >= right
--
-- This function does not support negative results.
--
-- Example:
--
--       1000
--     -    1
--     ------
--        999
local function subtract(left, right)

  -- Initialize the digit positions and borrowing state.
  --
  -- borrow is either:
  --   0 = no borrowing required
  --   1 = borrow one from the next column
  local i, j, borrow = #left, #right, 0

  -- Temporary array for result digits, in reverse order.
  local digits = {}

  -- Process every digit of the left operand.
  --
  -- Since left >= right, processing all digits of left
  -- is sufficient.
  while i > 0 do

    -- Read the current digit from left.
    --
    -- Subtract any borrow propagated from the
    -- previous column.
    local a = string.byte(left, i) - 48 - borrow

    -- Read the current digit from right.
    -- Use zero if no digits remain.
    local b = j > 0 and string.byte(right, j) - 48 or 0

    -- Determine whether this column needs borrowing.
    --
    -- If a < b, we need to borrow 10 from the next column.
    --
    -- The expression:
    --   condition and 1 or 0
    --
    -- is Lua's equivalent of:
    --   condition ? 1 : 0
    borrow = a < b and 1 or 0

    -- Compute the result digit.
    --
    -- If borrowing was required, add 10 to a.
    --
    -- Example:
    --   a = 0
    --   b = 7
    --   borrow = 1
    --
    --   0 - 7 + 10 = 3
    --
    -- Convert the resulting digit to ASCII
    -- and append it to our temporary array.
    table.insert(digits, string.char(48 + a - b + borrow * 10))

    -- Move to the next column on the left.
    i, j = i - 1, j - 1

  end

  -- Join and reverse the digits to restore normal order.
  --
  -- Remove leading zeros using a Lua pattern:
  --
  --   ^0+
  --
  -- Meaning:
  --   ^  = beginning of string
  --   0+ = one or more zeros
  --
  -- Example:
  --   "000999" -> "999"
  local result = string.gsub(
    string.reverse(table.concat(digits)),
    '^0+',
    ''
  )

  -- If the result was entirely zeros, the previous
  -- operation would have produced an empty string.
  --
  -- Return canonical "0" instead.
  return result == '' and '0' or result

end
`